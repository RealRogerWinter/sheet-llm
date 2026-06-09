import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getLLMClient } from '@/lib/llm'
import { completeWithRetry } from '@/lib/llm/messages'
import { RateLimitedError, UpstreamError, ProviderNotConfiguredError } from '@/lib/llm/errors'
import { OutputTruncatedError, ProviderSchemaError } from '@/lib/providers/types'
import { RENDER_SCORE_TOOL_NAME } from '@/lib/llm/renderScoreTool'
import {
  appendMessages,
  appendStreamingAssistant,
  createConversation,
  deleteConversation,
  finalizeStreamingMessage,
  getConversation,
  hasConversation,
} from '@/lib/llm/conversations'
import { maybeReapStalePartials, maybeReapStaleQuota } from '@/lib/db/maybeReap'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import type { AssistantContentBlock, ChatMessage } from '@/lib/llm/wrapper'
import type { Conversation } from '@/lib/llm/conversations'
import { validateAbc, validateScore } from '@/lib/music/validateScore'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import { ScoreSchema, type Score } from '@/lib/music/types'
import { ValidationError } from '@/lib/music/errors'
import type {
  ChatCta,
  ChatErrorCode,
  ChatResponse,
  TranscriptResponse,
  TranscriptTurn,
  VersionEntry,
} from '@/lib/shared/types'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import { run as runOrchestrator } from '@/lib/orchestrator'
import { getOrchestratorMode } from '@/lib/orchestrator/flags'
import {
  logShadowDivergence,
  readTurnCostByRequestId,
  updateTurnUsageByRequestId,
} from '@/lib/orchestrator/observability'
import type { OrchestratorMode } from '@/lib/orchestrator/flags'
import type {
  OrchestratorConverseStream,
  OrchestratorResult,
  OrchestratorScoreStream,
  TaskKind,
} from '@/lib/orchestrator/types'
import { isOrchestratorConverseStream, isOrchestratorScoreStream } from '@/lib/orchestrator/types'
import { summarizeAction } from '@/lib/orchestrator/summarizeAction'
import { recordUsage } from '@/lib/orchestrator/budget'
import { currentMeterTotals, runWithUsageMeter, toMicroUsd } from '@/lib/metering/usageMeter'
import { isPaidGenerationEnabled } from '@/lib/auth/account'
import { ensureWallet, getWallet, placeHold, refund, releaseHold, settleHold, type SettleResult } from '@/lib/billing/wallet'
import { maybeReapExpiredHolds } from '@/lib/billing/reap'
import { releaseFreePiece, reserveFreePiece } from '@/lib/billing/freePiece'
import {
  costToCredits,
  fallbackCreditsForKind,
  freePieceBudgetCredits,
  generationHoldCredits,
  markupForKind,
  MARKUP_GENERATE,
  sectionAbortMarginCredits,
  worstCaseHoldCredits,
} from '@/lib/billing/valueTier'
import { checkRequestIp, extractClientIp } from '@/lib/orchestrator/requestRateLimit'
import { checkByokIp } from '@/lib/orchestrator/byokRateLimit'
import { redactSecrets } from '@/lib/orchestrator/observability'
import { hasClearance } from '@/lib/security/turnstile'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'
import { computeDeadlineAt } from '@/lib/orchestrator/deadline'
import {
  resolveGenerationTier,
  policyFor,
  toTierPolicy,
  isTierOverrideAllowed,
  isByokKeyAccepted,
  warnByokHonoredInProd,
  isAdvancedComposerEnabled,
  resolveBoundedEmitCeiling,
} from '@/lib/orchestrator/generationTier'
import type { GenerationTier } from '@/lib/orchestrator/generationTier'
import { evaluateRequestQuota, isDailyQuotaEnabled } from '@/lib/orchestrator/dailyQuota'
import { quotaErrorBody } from '@/lib/chat/quotaMessages'
import { computeKeyStatus } from '@/lib/orchestrator/keyStatus'
import type { ChatDebugPayload } from '@/lib/shared/types'

export const runtime = 'nodejs'
// M25-PR-5: raised from 60 to give streamed sectional generation room to
// emit a multi-section piece (each section is a bounded sub-call; the SSE
// connection + keepalives stay open across them). The per-section calls
// are still individually bounded, so this is a ceiling, not a target.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// PR-7b-2c: wall-clock budget for the streamed SECTIONAL pump on a money-adjacent
// request (a placed hold, or a free piece). Stop pulling sections a margin before
// `maxDuration` so a long generation ends cleanly at a synthesized `done` (→ settle
// the metered partial) instead of being killed mid-flight → reaped → free (a real
// loss on the paid path). 30s of headroom covers the final settle + persist.
const SECTIONAL_STREAM_DEADLINE_MS = (maxDuration - 30) * 1_000

// M25-PR-5: raised from 24KB. A 16-bar grand-staff Score sent back up as
// `editedScore` on a refinement is ~30-50KB and was 413-ing on the very
// first refine. 1MB matches the batch per-score ceiling and stays well
// above the 32KB single-version cap (chat cap >= versions cap).
const MAX_BODY_BYTES = 1024 * 1024
const MAX_USER_TURNS = 20

const DebugOverridesSchema = z.object({
  orchestrator: z.enum(['on', 'off', 'shadow']).optional(),
  modelOverride: z.string().min(1).max(80).optional(),
  apiKey: z.string().min(8).max(256).optional(),
  // Debug-panel paywall toggle — a CLIENT-SUPPLIED field. resolveGenerationTier
  // honors it ONLY outside production (or when SL_ALLOW_TIER_OVERRIDE is set);
  // in production it is ignored so a client cannot POST generationTier='pro' to
  // bypass the paywall. See isTierOverrideAllowed in generationTier.ts.
  generationTier: z.enum(['free', 'pro']).optional(),
})

const ChatRequestSchema = z.object({
  chatId: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
  editedScore: ScoreSchema.optional(),
  score_version: z.string().min(1).max(64).optional(),
  // D5: deterministic measure-range hint from the right-click AI entries.
  targetRegion: z
    .object({
      startMeasureIdx: z.number().int().min(0).max(100000),
      endMeasureIdx: z.number().int().min(0).max(100000),
    })
    .optional(),
  // PR-8: the Advanced Composer (Opus) toggle. Honored ONLY for an authenticated
  // paid Pro generation and behind SL_ADVANCED_COMPOSER — it only ever raises the
  // user's OWN cost (cost-plus on Opus), never a free unlock; see handleChat.
  advancedComposer: z.boolean().optional(),
  debug: DebugOverridesSchema.optional(),
})

export function errorResponse(
  code: ChatErrorCode,
  status: number,
  error: string,
  chatId?: string,
  cta?: ChatCta,
) {
  // chatId is included so the client can keep its store pointed at
  // the same session and recover the orphan user row written by the
  // early `appendMessages([userTurn])` call. Omitted for errors that
  // fire before chatId resolution (parse / size / origin / lookup).
  const body: { code: ChatErrorCode; error: string; chatId?: string; cta?: ChatCta } = { code, error }
  if (chatId) body.chatId = chatId
  if (cta) body.cta = cta
  return NextResponse.json(body, { status })
}

/**
 * SHE-8 BYOK correctness — a clean onboarding response for a request that hit a
 * provider with no API key configured (and no BYOK override). Replaces the raw
 * `<ENV_VAR> is not set` 5xx with an actionable CTA to configure a key in
 * Settings. The user message never names the env var.
 */
function providerNotConfiguredResponse(chatId?: string) {
  return errorResponse(
    'provider_not_configured',
    503,
    'No AI provider is configured yet. Add an API key in Settings to start generating.',
    chatId,
    {
      kind: 'onboarding',
      title: 'Set up your AI provider',
      body: 'sheet-llm needs an API key to generate music. Add your own provider key (Anthropic, Groq, …) in Settings — it stays on this device/server.',
      primaryLabel: 'Open Settings',
      primaryHref: '/settings',
    },
  )
}

export function checkSameOrigin(request: Request): { ok: true } | { ok: false; res: ReturnType<typeof errorResponse> } {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return { ok: false, res: errorResponse('invalid_request', 403, 'Cross-origin requests are not allowed') }
      }
    } catch {
      return { ok: false, res: errorResponse('invalid_request', 400, 'Invalid Origin header') }
    }
  }
  return { ok: true }
}

function buildUserTurnForFirstCall(text: string): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function buildUserTurnForRefinement(
  prevToolUseId: string,
  text: string,
  editedScore?: Score,
): ChatMessage {
  // When the user has manually edited the score, encode the edit
  // INSIDE the tool_result.content (which references the prior LLM
  // tool_use_id). Doing this in the user turn — instead of injecting
  // a new assistant turn — preserves the API's strict role
  // alternation. Claude reads the edited score as the "outcome" of
  // its own prior render_score call.
  const toolResultContent = editedScore
    ? `The user manually edited the score after your last response. The current state is:\n\n${JSON.stringify(editedScore, null, 2)}\n\nApply the next instruction to THIS current state, not your previous output.`
    : ''
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: prevToolUseId, content: toolResultContent },
      { type: 'text', text },
    ],
  }
}

function findLastAssistantScore(transcript: ChatMessage[]): Score | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i]
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        return block.input as unknown as Score
      }
    }
  }
  return undefined
}

/**
 * Optional client freshness check. The client may send a `score_version`
 * (hash of the score it believes is current). If present and there's a
 * prior assistant score, reject mismatches. Absent / no prior score →
 * no-op.
 */
function checkScoreVersion(
  transcript: ChatMessage[],
  editedScore: Score | undefined,
  clientVersion: string | undefined,
): NextResponse | undefined {
  if (!clientVersion) return undefined
  if (!editedScore) return undefined
  const lastScore = findLastAssistantScore(transcript)
  if (!lastScore) return undefined
  const serverVersion = scoreHash(lastScore)
  if (clientVersion !== serverVersion) {
    return errorResponse(
      'stale_score',
      409,
      'Edited score is out of date with the server view. Refresh and try again.',
    )
  }
  return undefined
}

/** Synthetic tool_use ids minted by the orchestrator for non-LLM
 *  results (editScoreLevel, refuse). Anthropic never produced these,
 *  so they MUST NOT appear in `tool_result.tool_use_id` on the next
 *  refinement turn. */
const SYNTH_TOOL_USE_PREFIX = 'toolu_orch_'

function isSyntheticToolUseId(id: string): boolean {
  return id.startsWith(SYNTH_TOOL_USE_PREFIX)
}

function findLastToolUseId(transcript: ChatMessage[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i]
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type === 'tool_use' && !isSyntheticToolUseId(block.id)) return block.id
    }
  }
  return undefined
}

/**
 * Build the LLM-visible transcript: drop synthetic assistant turns
 * (orchestrator-served) and their immediately preceding user turn.
 * The orchestrator's effect is conveyed forward via the current
 * `editedScore` on the next request, not via history.
 *
 * Also collapses consecutive user turns to the most recent one. That
 * can happen when prior requests appended a user turn but errored
 * before any assistant turn was persisted (LLM 4xx/5xx, abort, etc.);
 * Anthropic merges consecutive same-role messages, and multiple
 * tool_result blocks with the same tool_use_id are rejected. The most
 * recent user turn carries the freshest edited-score state, so older
 * orphaned attempts can be dropped safely.
 */
function prepareMessagesForLLM(transcript: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of transcript) {
    if (m.role === 'assistant') {
      const toolUse = m.content.find((b) => b.type === 'tool_use') as
        | { type: 'tool_use'; id: string }
        | undefined
      if (toolUse && isSyntheticToolUseId(toolUse.id)) {
        // Synth turn — drop it AND the user turn that paired with it
        // (must be the most recent entry in out).
        if (out.length > 0 && out[out.length - 1].role === 'user') {
          out.pop()
        }
        continue
      }
    }
    if (m.role === 'user' && out.length > 0 && out[out.length - 1].role === 'user') {
      out[out.length - 1] = m
      continue
    }
    out.push(m)
  }
  return out
}

/**
 * Count only ANSWERED user-text turns toward the per-conversation cap.
 *
 * The user turn is persisted BEFORE the orchestrator/LLM runs (see the
 * early `appendMessages([userTurn])` in handleChat), so a request that
 * errors out (truncation, upstream drop, abort) leaves an ORPHAN user
 * turn with no paired assistant response. Counting orphans would let a
 * user who merely retried a failing prompt exhaust the 20-turn budget
 * and get locked out of the chat WITHOUT ever receiving a score. So a
 * user turn only counts once an assistant turn follows it; trailing /
 * consecutive orphan user turns are ignored.
 *
 * Exported for direct unit testing.
 */
export function countUserTextTurns(transcript: ChatMessage[]): number {
  let count = 0
  let pendingUser = false
  for (const m of transcript) {
    if (m.role === 'user' && m.content.some((c) => c.type === 'text')) {
      // A fresh user-text turn. Any previously-pending (unanswered) user
      // turn was an orphan from a failed attempt — it does not count; this
      // turn becomes the new pending one.
      pendingUser = true
    } else if (m.role === 'assistant' && pendingUser) {
      count++
      pendingUser = false
    }
  }
  return count
}

/**
 * Validate an editedScore for use in the next refinement turn.
 * Returns the validated Score (caller embeds it in the user turn's
 * tool_result content), or undefined if the request had no edit or
 * there's no prior tool_use to anchor to.
 *
 * Returns a NextResponse error on validation failure (400 / 422).
 */
async function validateEditedScoreOrError(
  transcript: ChatMessage[],
  editedScore: Score | undefined,
): Promise<Score | undefined | NextResponse> {
  if (!editedScore) return undefined
  if (!findLastToolUseId(transcript)) {
    // No prior assistant turn to anchor to — silently ignore the edit.
    return undefined
  }

  // Schema-only validation — semantic violations (e.g. a measure
  // that doesn't sum to the meter) are common mid-edit. Claude can
  // repair them as part of the refinement. Hard-rejecting here
  // would trap the user when they want to ask the model to fix it.
  const parsed = ScoreSchema.safeParse(editedScore)
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      400,
      `Edited score malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  return parsed.data
}

export async function POST(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  // Per-IP rate limit on the LLM-cost surface. The per-chatId token budget
  // (budget.ts) is resettable by rotating chatId and v1 has no per-user
  // metering, so this per-IP brake — keyed off CF-Connecting-IP behind
  // Cloudflare — is the backstop against unbounded Anthropic spend.
  if (!checkRequestIp(extractClientIp(request)).ok) {
    return errorResponse('rate_limited', 429, 'Too many requests — please slow down and try again shortly.')
  }

  // Bot-gate (Cloudflare Turnstile): keep automated clients off the LLM-cost
  // surface. No-op unless Turnstile is configured (both keys set).
  if (!(await hasClearance(request))) {
    return errorResponse('bot_check_required', 403, 'Please complete the bot check and try again.')
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let text: string
  try {
    text = await request.text()
  } catch {
    return errorResponse('invalid_request', 400, 'Could not read request body')
  }
  if (text.length > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let parsed
  try {
    parsed = ChatRequestSchema.parse(JSON.parse(text))
  } catch {
    return errorResponse('invalid_request', 400, 'Invalid request body')
  }

  // Resolve user identity from the signed cookie BEFORE we touch the
  // response stream — Next 16 forbids cookieStore.set after flush.
  const session = await getRequestUser()

  // Opportunistic janitor sweep — throttled to every 5 min and dispatched
  // via microtask, so it doesn't block this request. Lets us avoid a
  // dedicated cron without leaving stale `partial` rows around between
  // server restarts.
  maybeReapStalePartials()
  // Same opportunistic, throttled sweep for the daily-quota counters — gated so a
  // self-hosted instance with the quota feature off does nothing.
  if (isDailyQuotaEnabled()) maybeReapStaleQuota()
  // And for stranded credit holds (a crash between placeHold and settle/release)
  // — gated so a non-paid instance does nothing.
  if (isPaidGenerationEnabled()) maybeReapExpiredHolds()

  // Per-request API key override (from debug panel) is threaded through
  // ProviderCallOptions.apiKeyOverride rather than mutating process.env —
  // env mutation raced with long-lived streams.
  const response = await handleChat(session.userId, session.authenticated, parsed, request)
  return attachRecoveryHeader(response, session)
}

async function handleChat(
  userId: string,
  authenticated: boolean,
  parsed: z.infer<typeof ChatRequestSchema>,
  request: Request,
) {
  // Resolve chat id.
  let chatId: string
  if (parsed.chatId) {
    if (!(await hasConversation(userId, parsed.chatId))) {
      return errorResponse(
        'chat_not_found',
        410,
        'Chat session not found. Send again to start a fresh session.',
      )
    }
    chatId = parsed.chatId
  } else {
    chatId = await createConversation(userId)
  }

  // Re-load transcript through the scoped getter. If a concurrent DELETE
  // (e.g. from another tab) raced between hasConversation above and here,
  // the result is undefined — surface a clean 410 instead of crashing on
  // the non-null assertion that used to live here.
  const transcript = await getConversation(userId, chatId)
  if (!transcript) {
    return errorResponse(
      'chat_not_found',
      410,
      'Chat session not found. Send again to start a fresh session.',
    )
  }

  // 20-turn cap before adding this turn. Synthetic assistant turns
  // from edits don't count (they're role: 'assistant').
  if (countUserTextTurns(transcript) >= MAX_USER_TURNS) {
    return errorResponse(
      'chat_full',
      410,
      `This conversation reached the ${MAX_USER_TURNS}-turn limit. Click "New Score" to start a fresh session.`,
      chatId,
    )
  }

  // Validate any editedScore the user is sending up.
  const editResult = await validateEditedScoreOrError(transcript, parsed.editedScore)
  if (editResult instanceof NextResponse) return editResult
  const validatedEdit = editResult

  // Optional score_version freshness check. When the client asserts a
  // version AND there's a prior assistant score to compare against,
  // reject mismatches with 409 so the client can re-sync. Absent
  // score_version means the client opts out of the check.
  const versionCheck = checkScoreVersion(transcript, validatedEdit, parsed.score_version)
  if (versionCheck) return versionCheck

  // Build the user turn. On refinement, the tool_result.content
  // encodes the user's manual edits (if any) so Claude sees them as
  // the outcome of its own prior render_score call.
  const prevToolUseId = findLastToolUseId(transcript)
  const userTurn = prevToolUseId
    ? buildUserTurnForRefinement(prevToolUseId, parsed.message, validatedEdit)
    : buildUserTurnForFirstCall(parsed.message)

  // The orchestrator handlers (classify, editScoreLevel, editIntraMeasure,
  // compose, converse) all need the current score handed to them — they
  // don't read it from the transcript like the legacy Sonnet path does.
  // The client only sends `editedScore` when the user manually edited
  // (historyPointer > 0), so for an unedited follow-up to a generated
  // score we have to fall back to the most recent assistant-emitted
  // score. Without this, the classifier sees SCORE PRESENT: false and
  // refuses follow-up requests like "add 4 measures with a bridge".
  const orchestratorScore = validatedEdit ?? findLastAssistantScore(transcript)

  // Build the LLM-visible transcript in memory.
  const messagesForLLM = prepareMessagesForLLM([...transcript, userTurn])

  // Persist the user turn IMMEDIATELY, before the LLM call. If
  // anything downstream fails (LLM error, validation failure, auth-
  // cookie expiry, recovery-driven reload, network drop, tab close)
  // the user's prompt survives in the DB and reappears on transcript
  // hydration. Without this, an in-flight follow-up that doesn't
  // make it to the atomic `appendMessages([user, assistant])` call
  // below disappears entirely — both from the panel and from history
  // — which is the chat-vanish bug we're fixing.
  //
  // Retry safety: the orphan refinement turn references the prior
  // assistant's tool_use_id (which IS persisted), so no dangling
  // tool_result. On retry, `prepareMessagesForLLM` collapses
  // consecutive user turns to the most recent one (see the comment
  // on that function), so the freshest edited-score state wins and
  // older orphan attempts drop out of the LLM-visible history.
  await appendMessages(userId, chatId, [userTurn])

  // Orchestrator branch. Mode-gated:
  //   primary: orchestrator wins when it returns a result; refusal → 422.
  //   shadow:  orchestrator runs alongside legacy; legacy always wins
  //            the response; divergence is logged for evaluation.
  //   off:     orchestrator does not run at all.
  //
  // Debug overrides take precedence over env when present.
  const envMode = getOrchestratorMode()
  // `debug.orchestrator` is a CLIENT-supplied field (DebugOverridesSchema). Like
  // `debug.generationTier` it must be IGNORED in production: a paid Pro user
  // could otherwise POST debug.orchestrator='off'/'shadow' to route to the
  // UNCHARGED legacy single-shot path — a free-generation bypass of the paywall.
  // Honored only in the trusted dev/test context (or the explicit
  // SL_ALLOW_TIER_OVERRIDE opt-in), mirroring resolveGenerationTier's gate.
  const debugMode = isTierOverrideAllowed() ? parsed.debug?.orchestrator : undefined
  // SHE-8 — BYOK gate. `debug.apiKey` / `debug.modelOverride` are CLIENT-supplied
  // (DebugOverridesSchema); honoring `apiKey` unconditionally on the shared demo
  // is a key-laundering / billing-evasion primitive. Accept only in dev/test or
  // with the explicit SL_BYOK_ALLOWED self-host opt-in (fail-closed on hosted).
  const byokAccepted = isByokKeyAccepted()
  const byok = byokAccepted && !!parsed.debug?.apiKey
  if (byok && process.env.NODE_ENV === 'production') warnByokHonoredInProd()
  // A BYOK request is OFF our token-spend path (it pays its own provider bill)
  // but still consumes shared infra — bound it on a SEPARATE per-IP limiter so a
  // BYOK abuser can't evade the cost limiter's brake.
  if (byok && !checkByokIp(extractClientIp(request)).ok) {
    return errorResponse('rate_limited', 429, 'Too many requests — please slow down and try again shortly.')
  }
  const mode: OrchestratorMode =
    debugMode === 'on'
      ? 'primary'
      : debugMode === 'off'
        ? 'off'
        : debugMode === 'shadow'
          ? 'shadow'
          : envMode
  const requestId = crypto.randomUUID()
  const deadlineAt = computeDeadlineAt()
  // Resolve the product/paywall tier and thread the RESOLVED value into the
  // orchestrator so it stays DB-agnostic. Precedence: operator force-free kill
  // switch > debug-panel toggle (`parsed.debug?.generationTier`, dev-only) >
  // per-user entitlement (future) > env default. The debug override IS a
  // client-supplied request field (DebugOverridesSchema), so resolveGenerationTier
  // IGNORES it in production unless SL_ALLOW_TIER_OVERRIDE is set — otherwise any
  // caller could POST debug.generationTier='pro' and bypass the paywall.
  // See isTierOverrideAllowed in generationTier.ts.
  let generationTier = await resolveGenerationTier(userId, parsed.debug?.generationTier)

  // ── Free full piece (PR-7b-3 + PR-7b-2c reservation). A VERIFIED account's
  // ONE-TIME pro-scope generation, free + OFF the money path (a charge-SKIP, never
  // a credit grant — which would open refund farming). Restricted to FROM-SCRATCH
  // requests (no existing score ⇒ always a generation, never a free edit/converse,
  // so it can't be farmed). PR-7b-2c CLAIMS the grant here PRE-DISPATCH via the
  // atomic reserveFreePiece (folding the eligibility check INTO the claim) — closing
  // the consume-on-delivery TOCTOU where a concurrent from-scratch burst could each
  // run a free piece before the first consumed. This request now OWNS the grant. It
  // is RELEASED only on a non-delivery that incurred NO generation cost — the pre-run
  // handleChat exits (releasePreDispatch: quota / orchestrator-throw / refusal /
  // fall-through) and the streaming ZERO-section early failure. Once a section (or a
  // non-streaming result) is produced the raw cost is sunk, so the grant stays
  // consumed — the consumption IS the free piece's cost bound (also why a delivered
  // partial keeps it). `&&` short-circuits, so reserveFreePiece runs only for an
  // eligible-shaped request (flag on + verified + from-scratch) — never on an
  // edit/converse, never when the flag is off.
  // PR-13: reserveFreePiece now returns the per-claim OWNER TOKEN (or null). Keep
  // `freePiece` as the boolean the rest of handleChat reads, and thread the token
  // to the release sites so an un-claim is scoped to THIS request's reservation.
  // SHE-8 — a BYOK request pays its own provider bill, so it is OFF our money
  // path: never reserve/consume the free-piece grant for it.
  const freePieceToken =
    isPaidGenerationEnabled() && authenticated && !orchestratorScore && !byok
      ? reserveFreePiece(userId)
      : null
  const freePiece = freePieceToken !== null
  if (freePiece) generationTier = 'pro'

  // Pre-dispatch reservation state + the single release for BOTH pre-dispatch
  // reservations (the credit hold and the free-piece claim). Declared BEFORE the
  // quota gate so a quota rejection — or any later non-delivery exit — can release a
  // free-piece reservation already claimed above. holdId/holdCredits are assigned by
  // the paywall block below; only one of {holdId, freePiece} is ever set
  // (paidGeneration requires !freePiece). Each is a no-op when its reservation
  // wasn't made / already terminal, so it is safe to call on any non-delivery exit.
  let holdId: string | undefined
  let holdCredits = 0
  // Idempotent within THIS request: in shadow mode an orchestrator throw releases
  // here (catch) AND then falls through to the legacy release below — and the
  // free-piece grant is a shared per-USER row, so a second release could clear a
  // CONCURRENT request's fresh claim. Release at most once. (The hold is per-request,
  // so its double-release was already a harmless no-op; this hardens the free piece.)
  let preDispatchReleased = false
  const releasePreDispatch = (): void => {
    if (preDispatchReleased) return
    preDispatchReleased = true
    if (holdId) safeReleaseHold(holdId, requestId)
    if (freePieceToken) safeReleaseFreePiece(userId, freePieceToken, requestId)
  }

  // Daily request-quota gate (hosted abuse-gating layer; OFF by default — inert
  // for self-hosters). Slotted AFTER identity + tier are known and BEFORE any
  // orchestrator/LLM dispatch or SSE stream, so only requests that would actually
  // spend tokens are counted. The increment is intentionally pre-dispatch and is
  // NEVER refunded — moving token dispatch above this line, or adding a refund,
  // reopens an abuse oracle. Pre-LLM rejects above (origin/burst/turnstile/parse/
  // turn-cap/stale-score) never reach here, so they don't burn quota.
  const quota = evaluateRequestQuota({ userId, authenticated }, generationTier, request)
  if (!quota.ok) {
    releasePreDispatch() // give back a free-piece reservation claimed above (no-op otherwise)
    const body = quotaErrorBody(quota)
    return errorResponse(body.code, body.httpStatus, body.message, chatId, body.cta)
  }

  // ── Credit paywall (PR-7b-1 hold; PR-7b-2c fork-(b) sizing). Atomic PRE-DISPATCH
  // hold, fail-CLOSED. DARK until SL_PAID_GENERATION. Ordering: origin → bot-gate →
  // quota (fail-OPEN) → balance/hold (fail-CLOSED) → run → settle. Only an
  // authenticated Pro request (not a free piece) touches money; free tier + anon
  // stay off the money path entirely.
  //
  // PR-7b-2c sizes the hold to the user's AVAILABLE balance, clamped to
  // [worstCase, cap], instead of a fixed worst-case — so a large sectional can
  // settle up to the cap (the pump aborts before exceeding it; see
  // respondWithScoreStream). The START GATE stays at the non-streaming worst case:
  // a non-streaming turn has NO abort, so the hold must always cover it. A crashed
  // request self-heals via reapExpiredHolds.
  // SHE-8 — `!byok`: a BYOK request bills the user's own provider key, so it must
  // NOT enter the credit money path (no placeHold / settle against our wallet).
  const paidGeneration =
    isPaidGenerationEnabled() && authenticated && generationTier === 'pro' && !freePiece && !byok
  // PR-8 Advanced Composer (Opus). The client toggle is honored ONLY for a paid
  // Pro generation — so it is forced OFF for the free tier AND the free piece (we
  // never eat a free Opus run) — and behind SL_ADVANCED_COMPOSER. It only raises
  // the user's OWN cost (cost-plus on the higher Opus metered cost), so there is
  // no free-unlock abuse vector; the hold below is sized for Opus so an Advanced
  // settle never overdraws. Resolved here and threaded as the boolean into the
  // orchestrator, never the raw client field.
  const advancedComposer =
    parsed.advancedComposer === true && isAdvancedComposerEnabled() && paidGeneration
  if (paidGeneration) {
    try {
      ensureWallet(userId)
      const maxOutputTokens = policyFor('pro').maxOutputTokens
      // PR-8: an Advanced turn routes to Opus (~1.67× Sonnet) and bypasses the
      // sectional stream, so size the start-gate floor + hold for the Opus
      // non-streaming bound. A Standard turn keeps the Sonnet bound.
      const minToStart = worstCaseHoldCredits(maxOutputTokens, advancedComposer)
      const available = getWallet(userId).available
      if (available < minToStart) {
        // Can't even cover the non-streaming worst case — fail closed before run.
        return errorResponse(
          'insufficient_credits',
          402,
          "You're out of credits for Pro generation. Top up to keep going.",
          chatId,
        )
      }
      holdCredits = generationHoldCredits(available, maxOutputTokens, advancedComposer)
      const hold = placeHold({
        userId,
        requestId,
        idempotencyKey: `gen:${requestId}`,
        credits: holdCredits,
      })
      if (!hold.ok) {
        // The hold was sized to the just-read available balance, so this only
        // fails when a CONCURRENT request drained it between the read and the
        // atomic guard-in-the-write — fail closed.
        return errorResponse(
          'insufficient_credits',
          402,
          "You're out of credits for Pro generation. Top up to keep going.",
          chatId,
        )
      }
      if (hold.reused) {
        // A reused hold means this exact request id already placed one —
        // anomalous: requestId is a fresh per-request UUID so `gen:${requestId}`
        // is never reused. Refuse rather than risk serving or charging twice.
        console.error('[paywall] placeHold returned a reused hold — refusing (anomalous for a per-request key)', {
          requestId,
          status: hold.status,
        })
        return errorResponse(
          'internal_error',
          500,
          'Something went wrong starting your generation. Please try again.',
          chatId,
        )
      }
      holdId = hold.holdId
    } catch (e) {
      // FAIL-CLOSED: a wallet / DB error on the paid path REFUSES rather than
      // serving an uncharged generation.
      console.error('[paywall] hold placement failed — refusing (fail-closed)', {
        requestId,
        error: e instanceof Error ? e.message : String(e),
      })
      return errorResponse(
        'internal_error',
        500,
        'Billing is temporarily unavailable. Please try again in a moment.',
        chatId,
      )
    }
  }

  let orchestratorOutcome: Awaited<ReturnType<typeof runOrchestrator>> = null
  const tOrchStart = Date.now()
  try {
    if (mode !== 'off') {
      orchestratorOutcome = await runOrchestrator({
        requestId,
        chatId,
        userText: parsed.message,
        editedScore: orchestratorScore,
        history: messagesForLLM,
        // SHE-8 — both are CLIENT-supplied debug fields, gated behind the BYOK
        // acceptance check (dev/test or SL_BYOK_ALLOWED); ignored on hosted. NOTE:
        // BYOK is honored only on the orchestrator path; a legacy fall-through
        // (mode=off / low-confidence / handler error) runs on the server's own
        // key+model. Benign for the single-tenant self-host this targets (server
        // key == operator key, and BYOK is off the money path).
        modelOverride: byokAccepted ? parsed.debug?.modelOverride : undefined,
        ...(byok && parsed.debug?.apiKey ? { apiKeyOverride: parsed.debug.apiKey } : {}),
        ...(parsed.targetRegion ? { targetRegion: parsed.targetRegion } : {}),
        deadlineAt,
        generationTier,
        // SHE-8 — the orchestrator reads ONLY this injected policy for
        // paywall/scope decisions (it no longer imports policyFor). Built from
        // the resolved tier, so the hosted paywall stays fail-closed here.
        tierPolicy: toTierPolicy(generationTier),
        advancedComposer,
      })
    }
  } catch (e) {
    // Any orchestrator throw means nothing was delivered — release both
    // pre-dispatch reservations (the credit hold and/or the free-piece claim;
    // no-op off the paid + free-piece paths).
    releasePreDispatch()
    if (mode === 'shadow') {
      const errMsg = e instanceof Error ? e.message : 'Unknown orchestrator error'
      logShadowDivergence({
        requestId,
        label: 'unknown',
        diverged: true,
        reason: `orchestrator_threw: ${errMsg}`,
        latencyMsOrchestrator: Date.now() - tOrchStart,
      })
      orchestratorOutcome = null
    } else if (e instanceof RateLimitedError) {
      return errorResponse('rate_limited', 503, e.message, chatId)
    } else if (e instanceof ProviderNotConfiguredError) {
      return providerNotConfiguredResponse(chatId)
    } else if (e instanceof UpstreamError) {
      return errorResponse('upstream_error', e.status === 500 ? 502 : e.status, e.message, chatId)
    } else if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, `Score validation failed after retries: ${e.message}`, chatId)
    } else if (e instanceof OutputTruncatedError) {
      // The model ran past its token ceiling before finishing the score.
      // Surface a clean, actionable message rather than the raw schema
      // failure — and never echo the Zod internals to the user.
      console.error('[chat] generation truncated at max_tokens', { chatId, requestId, error: redactSecrets(e.message) })
      return errorResponse(
        'output_too_large',
        422,
        'This piece is too large to generate in one pass. Try asking for fewer bars — full-length sectional generation is on the way.',
        chatId,
      )
    } else if (e instanceof ProviderSchemaError) {
      console.error('[chat] provider returned malformed tool input', { chatId, requestId, error: redactSecrets(e.message) })
      return errorResponse('upstream_error', 502, 'The model returned an unexpected response. Please try again.', chatId)
    } else {
      // Log the raw detail server-side; return a generic message so we
      // never leak internal error strings (e.g. Zod paths) to the user.
      console.error('[chat] orchestrator failed', {
        chatId,
        requestId,
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      })
      return errorResponse('internal_error', 500, 'Something went wrong while generating your score. Please try again.', chatId)
    }
  }

  if (mode === 'primary' && orchestratorOutcome) {
    if ('refused' in orchestratorOutcome) {
      releasePreDispatch() // a refusal carries no Score: never charges, frees the grant.
      return errorResponse('refused', 422, orchestratorOutcome.reason, chatId)
    }
    if (isOrchestratorConverseStream(orchestratorOutcome)) {
      // PR-7b-2: the responder OWNS the hold — it settles at message-stop off the
      // backfilled cost_micro_usd and releases on any non-completing exit.
      return await respondWithConverseStream(userId, chatId, orchestratorOutcome, mode, generationTier, requestId, holdId)
    }
    if (isOrchestratorScoreStream(orchestratorOutcome)) {
      // PR-7b-2: settled at `done` off the (backfilled) full sectional cost.
      // PR-7b-2c: the responder OWNS the hold + the free-piece reservation — it
      // settles/keeps on delivery and releases both on a non-delivery exit, and it
      // ABORTS the sectional before the metered cost exceeds `holdCredits` (or a
      // wall-clock budget). holdCredits is the placed hold amount (0 off the paid
      // path → no cost-abort; a free piece is wall-clock-bounded only).
      return await respondWithScoreStream(userId, chatId, orchestratorOutcome, mode, generationTier, requestId, holdId, freePiece, freePieceToken, holdCredits)
    }
    if (!('fellThrough' in orchestratorOutcome)) {
      // Non-streaming result: respondWithOrchestratorResult OWNS the hold — it
      // settles on delivery and releases on a validation/persist failure — so we
      // must NOT releasePreDispatch() here. The free-piece grant (if any) was
      // claimed pre-dispatch and is kept consumed by this post-cost responder.
      return await respondWithOrchestratorResult(
        userId,
        chatId,
        orchestratorOutcome,
        mode,
        generationTier,
        requestId,
        holdId,
      )
    }
    // fellThrough — drop through to the legacy path below; the
    // outcome's classification + reason is captured into the debug
    // payload after the legacy call.
  }

  // Everything below is the fall-through / legacy single-shot path, which
  // PR-7b-1 does not meter or charge — release any pre-dispatch reservation now
  // (credit hold and/or free-piece claim). No-op off those paths, or if already
  // released/settled above. The free-piece backstop below then refuses (keeping
  // the now-released grant unspent for a retry); a paid request likewise refuses.
  releasePreDispatch()

  // Capture the orchestrator's fall-through outcome (if any) so the
  // debug payload can surface WHY the legacy path served this turn.
  const fallThrough =
    mode === 'primary' && orchestratorOutcome && 'fellThrough' in orchestratorOutcome
      ? orchestratorOutcome
      : null

  // M26 follow-up — a DEADLINE fall-through must NOT run the unbounded legacy
  // path. The deadline exists to cap wall-clock; falling through to a second
  // full LLM generation defeats it (observed: a slow dispatch tripped the ~55s
  // budget, then legacy ran a further ~26s = 83s total). Other fall-through
  // reasons (low_confidence, handler_error) still use legacy as the safety net.
  if (fallThrough?.reason === 'deadline_exceeded') {
    console.warn('[chat] deadline exceeded — returning clean error instead of legacy', {
      chatId,
      requestId,
    })
    return errorResponse(
      'deadline_exceeded',
      503,
      'This request is taking too long to finish. Try a smaller change, or ask for fewer bars.',
      chatId,
    )
  }

  // M26 follow-up — free tier does NOT run the legacy full-score regen on a
  // fall-through. Even token-capped it's slow (~1-2min for a dense score) AND
  // tends to emit invalid scores for refinements (observed: "Measure N: duration
  // sum ...", "measures: expected array"). The bounded handlers + the dispatch
  // reroute are the real free-tier path; if the turn still fell through, return
  // a fast, clean error rather than hand the user a slow, broken regen. (This
  // fires only when the orchestrator RAN and bailed — mode='off' has no result
  // to fall back FROM and still uses the bounded legacy below.)
  if (fallThrough && generationTier === 'free') {
    console.warn('[chat] free-tier fall-through — clean error instead of legacy regen', {
      chatId,
      requestId,
      reason: fallThrough.reason,
    })
    return errorResponse(
      'refused',
      422,
      "I couldn't apply that as a quick edit. Try rephrasing it as a smaller, more specific change — or switch to Pro for full rewrites.",
      chatId,
    )
  }

  // A PAID or FREE-PIECE request must NEVER be served by the uncharged legacy
  // single-shot path (PR-7b-1 does not meter or charge legacy). Reaching here
  // means a non-deadline fall-through (low_confidence / handler_error), a
  // from-scratch converse (no score ⇒ falls through), or mode off / shadow /
  // kill — refuse instead of handing out a free Pro generation.
  //   - PAID (PR-7b-1): else an uncharged Pro delivery.
  //   - FREE PIECE (PR-7b-3): the free piece is consumed ONLY on an orchestrator
  //     delivery (the two responders). Serving it via legacy would deliver a free
  //     UNBOUNDED Pro generation that NEVER consumes the grant → unlimited free
  //     Pro, repeatable. Refusing keeps the grant unspent so a retry gets the
  //     real (orchestrator, consumed) free piece. This also closes the converse
  //     path (respondWithConverseStream is unreachable from-scratch).
  // The hold was already released above (no-op for a free piece — no hold). This
  // is the backstop behind the debug.orchestrator gate: even an operator kill
  // switch can't leak a free Pro generation.
  if (paidGeneration || freePiece) {
    console.warn('[paywall] paid/free-piece request would hit the uncharged legacy path — refusing', {
      requestId,
      chatId,
      mode,
      freePiece,
      fallThroughReason: fallThrough?.reason,
    })
    return errorResponse(
      'refused',
      422,
      "I couldn't complete that on the Pro path just now. Please try again in a moment.",
      chatId,
    )
  }

  // Shadow mode: capture orchestrator outcome for divergence logging
  // after the legacy path runs below.
  const shadowOutcome = mode === 'shadow' ? orchestratorOutcome : null
  const tOrchEnd = Date.now()

  // Call LLM with retry; only the final successful exchange comes back.
  // Free-tier fall-throughs are short-circuited above (clean error, no regen),
  // so reaching here on free tier means mode='off' (orchestrator disabled) —
  // still cap it to the bounded ceiling + a single retry so even that path
  // can't run an unbounded regen. Pro keeps the full budget.
  const legacyBounded = generationTier === 'free'
  let result
  try {
    result = await completeWithRetry(
      getLLMClient(),
      {
        messages: messagesForLLM,
        ...(legacyBounded ? { maxTokens: resolveBoundedEmitCeiling() } : {}),
      },
      legacyBounded ? { maxRetries: 1 } : {},
    )
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, `Score validation failed after retries: ${e.message}`, chatId)
    }
    if (e instanceof RateLimitedError) {
      return errorResponse('rate_limited', 503, e.message, chatId)
    }
    if (e instanceof ProviderNotConfiguredError) {
      return providerNotConfiguredResponse(chatId)
    }
    if (e instanceof UpstreamError) {
      return errorResponse('upstream_error', e.status === 500 ? 502 : e.status, e.message, chatId)
    }
    const message = e instanceof Error ? e.message : 'Unknown LLM error'
    return errorResponse('upstream_error', 502, `LLM call failed: ${message}`, chatId)
  }

  // Transpile + sanity-check ABC BEFORE persisting so a render failure
  // leaves the assistant turn off the DB. The user turn was already
  // persisted by the early `appendMessages([userTurn])` call so a retry
  // can collapse it; only the assistant write is gated on validation.
  let abc: string
  try {
    abc = scoreToAbc(result.response.score)
    await validateAbc(abc)
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, e.message, chatId)
    }
    throw e
  }

  // Confirmation text for the legacy path: same rule as the orchestrator
  // branch — prefer the model's pre-tool-use narration when present,
  // else a deterministic canned summary derived from the resulting
  // Score (the legacy path doesn't carry structured ops, so the
  // fallback branch in `summarizeAction` is used).
  const legacyIntroText =
    result.response.introText ??
    summarizeAction({
      score: result.response.score,
      classification: fallThrough?.classification ?? {
        kind: 'fall_through',
        scope: 'short',
        complexity: 'simple',
        confidence: 0,
      },
      model: null,
      latencyMs: tOrchEnd - tOrchStart,
    })

  // If the model did NOT emit a text block, the persisted assistantTurn
  // is just `[tool_use]`. Inject the canned text up front so transcript
  // hydration (mapTranscriptToTurns) recovers the same introText shown
  // in this response on reload.
  const persistedAssistantTurn: ChatMessage = result.response.introText
    ? result.assistantTurn
    : {
        role: 'assistant',
        content: [
          { type: 'text', text: legacyIntroText },
          ...(result.assistantTurn.content as AssistantContentBlock[]),
        ] as AssistantContentBlock[],
      }

  // User turn already persisted upstream; append the assistant turn
  // (its score_versions row + head pointer bump happen inside).
  await appendMessages(userId, chatId, [persistedAssistantTurn])

  // Shadow-mode divergence log. The legacy path is the source of
  // truth for the response; this records what the orchestrator would
  // have returned so we can grade it before flipping primary.
  if (shadowOutcome !== null && shadowOutcome !== undefined) {
    // Converse outcomes are streaming and have no Score to diff against
    // the legacy path's render — skip divergence comparison.
    if (isOrchestratorConverseStream(shadowOutcome) || isOrchestratorScoreStream(shadowOutcome)) {
      // Intentionally no-op: streaming outcomes have no single Score to
      // diff against the legacy render.
    } else if ('fellThrough' in shadowOutcome) {
      logShadowDivergence({
        requestId,
        label: shadowOutcome.classification?.kind ?? 'unknown',
        diverged: true,
        reason: `orchestrator_fell_through: ${shadowOutcome.reason}`,
        latencyMsOrchestrator: tOrchEnd - tOrchStart,
        latencyMsLegacy: Date.now() - tOrchEnd,
      })
    } else {
      const diverged =
        'refused' in shadowOutcome
          ? true
          : JSON.stringify(shadowOutcome.score) !== JSON.stringify(result.response.score)
      const reason =
        'refused' in shadowOutcome
          ? `orchestrator_refused: ${shadowOutcome.refusalCode}`
          : diverged
            ? 'different_score'
            : 'matched'
      logShadowDivergence({
        requestId,
        label: 'refused' in shadowOutcome ? 'refuse' : shadowOutcome.classification.kind,
        diverged,
        reason,
        latencyMsOrchestrator: tOrchEnd - tOrchStart,
        latencyMsLegacy: Date.now() - tOrchEnd,
      })
    }
  }

  const keyConfigured = !!process.env.ANTHROPIC_API_KEY
  const legacyClient: 'real' | 'stub' = keyConfigured ? 'real' : 'stub'
  const debug: ChatDebugPayload = {
    handler: 'legacy',
    // When the stub is the legacy client, no model was actually
    // consulted — surface that honestly instead of pretending Sonnet
    // ran.
    model: legacyClient === 'stub' ? null : 'claude-sonnet-4-6',
    latencyMs: tOrchEnd - tOrchStart,
    fellThrough: fallThrough !== null,
    ...(fallThrough?.reason ? { fallThroughReason: fallThrough.reason } : {}),
    ...(fallThrough?.errorMessage ? { fallThroughError: fallThrough.errorMessage } : {}),
    ...(fallThrough?.classification
      ? {
          classification: {
            kind: fallThrough.classification.kind,
            scope: fallThrough.classification.scope,
            complexity: fallThrough.classification.complexity,
            confidence: fallThrough.classification.confidence,
            reason: fallThrough.classification.reason,
          },
        }
      : {}),
    mode,
    keyConfigured,
    legacyClient,
    keyStatus: computeKeyStatus(),
    generationTier,
  }

  const body: ChatResponse = {
    chatId,
    abc,
    introText: legacyIntroText,
    scoreJson: result.response.score,
    toolUseId: result.response.toolUseId,
    headVersionId: await readHeadVersionId(chatId),
    debug,
  }
  return NextResponse.json(body)
}

/**
 * Read sessions.head_version_id directly. Called after appendMessages
 * so the value reflects the just-inserted score_versions row — the
 * client uses it as parentVersionId on subsequent edit POSTs to
 * /api/sessions/:id/versions.
 */
async function readHeadVersionId(chatId: string): Promise<string | undefined> {
  const { getDb } = await import('@/lib/db')
  const { sessions: sessionsTable } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const row = await getDb()
    .select({ head: sessionsTable.headVersionId })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, chatId))
    .limit(1)
    .get()
  return row?.head ?? undefined
}

/**
 * Tool-use id format that matches the prefix used elsewhere (stubClient)
 * and stays within Anthropic's expected id length range.
 */
export function synthToolUseId(): string {
  return `toolu_orch_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`
}

/**
 * Tool-use id minted by /api/chat/fork for the seeded assistant turn.
 * Distinct prefix because, unlike orchestrator-synthetic ids, fork-seed
 * ids ARE valid anchors for follow-up refinements: the seeded turn
 * represents a real prior score the user is choosing to continue from,
 * and `prepareMessagesForLLM` / `findLastToolUseId` must treat it as a
 * normal assistant turn (not strip it).
 */
export function forkSeedToolUseId(): string {
  return `toolu_fork_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`
}

/**
 * Release a credit hold without charging, logging (never throwing) on failure —
 * a stranded hold self-heals via reapExpiredHolds. No-op once the hold has
 * settled (settleHold flips it to 'settled'; releaseHold only acts on 'active'),
 * so it is safe to call on any non-settle exit, even redundantly. (PR-7b-1.)
 */
function safeReleaseHold(holdId: string, requestId: string): void {
  try {
    releaseHold(holdId)
  } catch (e) {
    console.error('[paywall] hold release failed (reaper will recover)', {
      requestId,
      holdId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Release a pre-dispatch FREE-PIECE reservation (PR-7b-2c) without delivering —
 * un-claims `free_full_piece_used_at` so a retry is eligible again. Logs, never
 * throws (a stranded reservation is a one-time, low-impact perk loss, not a money
 * fault). Call on any non-delivery exit of a request that reserved the free piece;
 * NEVER after a delivered piece (that keeps the grant consumed). Symmetric with
 * safeReleaseHold.
 */
function safeReleaseFreePiece(userId: string, token: string, requestId: string): void {
  try {
    releaseFreePiece(userId, token)
  } catch (e) {
    console.error('[paywall] free-piece reservation release failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/** The metered RAW cost (µUSD) + token split a settle charges against. */
interface SettleCost {
  costMicroUsd: number | null
  inputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
}

/**
 * The settle cost for a NON-STREAMING turn: orchestrator_turns.cost_micro_usd,
 * which run() persisted (dispatcher + handler + retries) before returning.
 */
function turnRowCost(requestId: string): SettleCost {
  const turn = readTurnCostByRequestId(requestId)
  return {
    costMicroUsd: turn?.costMicroUsd ?? null,
    ...(turn?.inputTokens != null ? { inputTokens: turn.inputTokens } : {}),
    ...(turn?.cachedInputTokens != null ? { cachedInputTokens: turn.cachedInputTokens } : {}),
    ...(turn?.cacheCreationInputTokens != null
      ? { cacheCreationInputTokens: turn.cacheCreationInputTokens }
      : {}),
    ...(turn?.outputTokens != null ? { outputTokens: turn.outputTokens } : {}),
  }
}

/**
 * The settle cost for a STREAMING turn: the request-scoped usage meter snapshot,
 * read INSIDE the pump scope at `done`. run() DOES write an orchestrator_turns
 * row for a stream outcome (index.ts ~948/967) and backfillStreamedTurnCost adds
 * the streamed cost to it — but that backfill is a BEST-EFFORT DB UPDATE that can
 * silently fail (and the route never sees the pre-call cost regardless). The
 * in-memory meter is the robust source: always populated in-scope by
 * recordProviderCall for every section/delta, immune to a backfill DB failure, so
 * a streamed turn never NULL-fallbacks to a flat charge on a transient DB hiccup.
 * It omits the in-run pre-call (classifier/dispatcher) cost — a deliberate,
 * bounded ~1–5 credit undercount.
 */
function meterStreamCost(): SettleCost {
  const m = currentMeterTotals()
  if (!m || m.callCount === 0) return { costMicroUsd: null }
  return {
    costMicroUsd: toMicroUsd(m.costUsd),
    inputTokens: m.inputTokens,
    cachedInputTokens: m.cachedInputTokens,
    cacheCreationInputTokens: m.cacheCreationInputTokens,
    outputTokens: m.outputTokens,
  }
}

/**
 * Settle a DELIVERED turn's hold to the cost-plus charge against `cost`. Shared
 * by the non-streaming (respondWithOrchestratorResult) and streaming (converse /
 * score) settle sites so the money logic is identical:
 *   - charge = costToCredits(cost, markupForKind(kind)) — 2.5× gen / 1.2× edit,
 *   - FAIL-CLOSED when the cost is unreadable on a delivered turn: charge the
 *     flat value-tier fallback (NULL ≠ free) + alert,
 *   - never charges above the hold (settleHold caps the debit and flags overHold).
 * Returns the SettleResult; the caller treats `{ok:false}` (hold_not_active) as a
 * hard error — never deliver an uncharged generation. (PR-7b.)
 */
function settleHeldGeneration(args: {
  holdId: string
  requestId: string
  chatId: string
  generationTier: GenerationTier
  kind: TaskKind
  model: string | null
  cost: SettleCost
}): SettleResult {
  const microUsd = args.cost.costMicroUsd
  let creditsCharged: number
  if (microUsd != null && microUsd > 0) {
    creditsCharged = costToCredits(microUsd, markupForKind(args.kind))
  } else {
    creditsCharged = fallbackCreditsForKind(args.kind)
    console.error('[paywall] metered cost unreadable on a delivered turn — charging flat fallback', {
      requestId: args.requestId,
      chatId: args.chatId,
      kind: args.kind,
      costMicroUsd: microUsd,
      fallbackCredits: creditsCharged,
    })
  }
  const settle = settleHold({
    holdId: args.holdId,
    creditsCharged,
    ...(microUsd != null ? { costMicroUsd: microUsd } : {}),
    kind: `chat:${args.kind}`,
    ...(args.model ? { model: args.model } : {}),
    generationTier: args.generationTier,
    requestId: args.requestId,
    sessionId: args.chatId,
    idempotencyKey: `settle:${args.requestId}`,
    ...(args.cost.inputTokens != null ? { inputTokens: args.cost.inputTokens } : {}),
    ...(args.cost.cachedInputTokens != null ? { cachedInputTokens: args.cost.cachedInputTokens } : {}),
    ...(args.cost.cacheCreationInputTokens != null
      ? { cacheCreationInputTokens: args.cost.cacheCreationInputTokens }
      : {}),
    ...(args.cost.outputTokens != null ? { outputTokens: args.cost.outputTokens } : {}),
  })
  if (settle.ok && settle.overHold) {
    console.error('[paywall] OVER-HOLD: charge exceeded the reservation (capped) — hold-sizing alert', {
      requestId: args.requestId,
      chatId: args.chatId,
      holdId: args.holdId,
      creditsCharged: settle.creditsCharged,
    })
  }
  return settle
}

/**
 * Wrap an orchestrator-produced Score in the same response/persistence
 * shape as the legacy LLM path: validate it, transpile ABC, persist a
 * synthetic assistant turn so future refinements can anchor against
 * its tool_use_id.
 *
 * NOTE (Phase 1+ TODO): When `result.toolUseId` is a synthetic
 * `toolu_orch_*` id and a later request reverts to the legacy path,
 * the next refinement's tool_result will reference an id Anthropic
 * never produced and the API will reject it. Fix when handlers ship:
 * either tag synthetic blocks so findLastToolUseId skips them, or
 * carry a separate "last-real-Anthropic-tool-use-id" pointer.
 */
async function respondWithOrchestratorResult(
  userId: string,
  chatId: string,
  result: OrchestratorResult,
  mode: OrchestratorMode,
  generationTier: GenerationTier,
  requestId?: string,
  holdId?: string,
  // NB no `freePiece` param: a free piece is CLAIMED pre-dispatch (reserveFreePiece)
  // and this responder is reached only AFTER run() incurred cost, so the grant is
  // simply KEPT consumed whether this delivers or fails — nothing to do here. (The
  // free-piece release lives only on the pre-cost handleChat exits + the streaming
  // zero-section path.)
) {
  // NB the hold vs free-piece asymmetry on a post-`run()` failure: the paid HOLD is
  // RELEASED (we never charge for an undelivered turn), but the free-piece grant is
  // KEPT consumed — reaching this responder means run() already incurred the LLM
  // cost, and the grant-consumption IS the free piece's cost bound (releasing it
  // would let a user repeatedly burn free generation cost on induced failures).
  try {
    validateScore(result.score)
  } catch (e) {
    if (holdId && requestId) safeReleaseHold(holdId, requestId)
    if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, `Orchestrator emitted an invalid score: ${e.message}`, chatId)
    }
    throw e
  }

  let abc: string
  try {
    abc = scoreToAbc(result.score)
    await validateAbc(abc)
  } catch (e) {
    if (holdId && requestId) safeReleaseHold(holdId, requestId)
    if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, e.message, chatId)
    }
    throw e
  }

  const id = result.toolUseId ?? synthToolUseId()
  // Confirmation text: prefer the model's own pre-tool-use narration
  // when it emitted any (zero cost — same call), else a deterministic
  // canned summary derived from the structured ops or the resulting
  // Score. Always non-empty so the conversation panel and the under-
  // score label always have something to render for an action turn.
  const introText = result.introText ?? summarizeAction(result)
  const assistantContent: AssistantContentBlock[] = [
    { type: 'text', text: introText },
    {
      type: 'tool_use',
      id,
      name: RENDER_SCORE_TOOL_NAME,
      input: result.score as unknown as Record<string, unknown>,
    },
  ]
  // M3.5-PR-4 — replacement-as-confirmation gate. When `requiresConfirmation`
  // is true, persist the assistant turn + create the candidate score_versions
  // row, but DON'T advance sessions.head_version_id. The candidate hangs
  // off the prior head and the next /api/chat/confirm-replacement POST
  // either advances the head (accept) or writes a no-op revert row
  // (reject).
  //
  // M24-PR-2 — ghost preview reuses the same gate path: when
  // `result.proposal` is set the orchestrator sets `requiresConfirmation`
  // too, so the head-bump skip + candidate-row creation Just Work. The
  // response payload below branches on which field is populated.
  // ── PR-7b-1 paywall settle (non-streaming). A hold was placed pre-dispatch;
  // charge the ACTUAL metered cost (cost-plus) BEFORE persisting/delivering so
  // we never deliver an uncharged generation. (Validation failures above
  // released the hold instead — nothing was produced to charge for.) A
  // confirmation-gated candidate (requiresConfirmation / previewMode) IS charged
  // here too — the generation cost was incurred regardless of accept/reject.
  let settledCredits = 0
  if (holdId && requestId) {
    const settle = settleHeldGeneration({
      holdId,
      requestId,
      chatId,
      generationTier,
      kind: result.classification.kind,
      model: result.model,
      cost: turnRowCost(requestId), // run() persisted the full non-streaming cost
    })
    if (!settle.ok) {
      // hold_not_active — the hold was already settled/released (impossible for
      // a non-streaming turn). Never deliver an uncharged generation: refuse. We
      // absorb the raw cost; this is a paging bug, not the business model.
      console.error('[paywall] settle refused (hold_not_active) — refusing delivery', {
        requestId,
        chatId,
        holdId,
      })
      return errorResponse(
        'internal_error',
        500,
        'We hit a billing error finishing your generation. Please try again.',
        chatId,
      )
    }
    settledCredits = settle.creditsCharged
  }

  const gateFired = result.requiresConfirmation === true
  let newScoreVersionId: string | null = null
  try {
    ;({ newScoreVersionId } = await appendMessages(
      userId,
      chatId,
      [{ role: 'assistant', content: assistantContent }],
      gateFired ? { skipHeadVersionBump: true } : undefined,
    ))
  } catch (e) {
    // Charged but failed to persist/deliver → refund OUR failure so the user
    // isn't billed for a generation they never received. refund() is namespaced
    // (refund:* vs settle:*), idempotent, and abuse-bounded.
    if (holdId && requestId && settledCredits > 0) {
      try {
        const r = refund({
          userId,
          requestId,
          holdId,
          credits: settledCredits,
          reason: 'error',
          sessionId: chatId,
          idempotencyKey: `refund:${requestId}:persist_failed`,
        })
        if (!r.ok) {
          // refund() returns {ok:false} (it does NOT throw) when the per-day
          // refund ceiling is hit — the customer stays charged for an undelivered
          // turn. Surface it loudly for manual reconciliation; never swallow it.
          console.error('[paywall] refund after persist failure DENIED — manual reconcile', {
            requestId,
            chatId,
            reason: r.reason,
            credits: settledCredits,
          })
        }
      } catch (re) {
        console.error('[paywall] refund after persist failure FAILED — manual reconcile', {
          requestId,
          chatId,
          error: re instanceof Error ? re.message : String(re),
        })
      }
    }
    // The free piece is KEPT consumed here (no release): run() already incurred the
    // LLM cost, so the grant-consumption is its cost bound (see the asymmetry note
    // above). The paid hold, by contrast, was refunded just above.
    throw e
  }

  // PR-7b-2c: the free piece was CLAIMED pre-dispatch (reserveFreePiece), so a
  // delivered piece simply KEEPS it consumed — nothing to do here. Every
  // non-delivery path above released the reservation instead. (The grant is only
  // ever set for a from-scratch request, so it never burns on an edit/converse.)

  const keyConfigured = !!process.env.ANTHROPIC_API_KEY
  const debug: ChatDebugPayload = {
    classification: {
      kind: result.classification.kind,
      scope: result.classification.scope,
      complexity: result.classification.complexity,
      confidence: result.classification.confidence,
      reason: result.classification.reason,
    },
    handler: result.classification.kind,
    model: result.model,
    latencyMs: result.latencyMs,
    fellThrough: false,
    mode,
    keyConfigured,
    legacyClient: keyConfigured ? 'real' : 'stub',
    keyStatus: computeKeyStatus(),
    generationTier,
  }
  const body: ChatResponse = {
    chatId,
    abc,
    introText,
    scoreJson: result.score,
    toolUseId: id,
    headVersionId: await readHeadVersionId(chatId),
    debug,
    ...(gateFired
      ? result.replacement
        ? {
            requiresConfirmation: true as const,
            replacement: {
              retainedIdentityRatio: result.replacement.retainedIdentityRatio,
              reasons: result.replacement.reasons,
              // candidateVersionId is the newly-inserted (orphan-until-
              // confirmed) score_versions row. The UI POSTs this back to
              // /api/chat/confirm-replacement to either advance the head
              // or write a revert row.
              candidateVersionId: newScoreVersionId ?? '',
            },
          }
        : result.proposal
          ? {
              requiresConfirmation: true as const,
              proposal: {
                affectedEventIds: result.proposal.affectedEventIds,
                candidateVersionId: newScoreVersionId ?? '',
              },
            }
          : { requiresConfirmation: true as const }
      : {}),
  }
  return NextResponse.json(body, { headers: { 'X-Orchestrator-Label': result.classification.kind } })
}

/**
 * Backfill a streamed turn's true cost from the request-scoped usage meter.
 * Called on a completed stream, INSIDE the route's runWithUsageMeter scope, so
 * `currentMeterTotals()` reflects the provider calls the pump just drove. No-op
 * when the meter saw nothing (e.g. the stub client). This is what stops the
 * paywall (PR-7b) settling a streamed generation against a null cost.
 */
function backfillStreamedTurnCost(requestId: string): void {
  const m = currentMeterTotals()
  if (!m || m.callCount === 0) return
  updateTurnUsageByRequestId(requestId, {
    inputTokens: m.inputTokens,
    cachedInputTokens: m.cachedInputTokens,
    cacheCreationInputTokens: m.cacheCreationInputTokens,
    outputTokens: m.outputTokens,
    costMicroUsd: toMicroUsd(m.costUsd),
  })
}

/**
 * PR-7b-2c sectional abort decision (pure, exported for unit tests). Decides, after
 * each completed section, whether the streamed sectional pump should STOP pulling
 * more sections:
 *   - 'budget' (PAID path): the cost-plus credits of the metered cost so far has
 *     reached `budgetCredits − abortMargin`. Checked AFTER a section completes, so
 *     the margin leaves room for that section's charge to stay within the hold;
 *     settleHold's cap is the hard backstop if a pathological section overshoots.
 *   - 'wall_clock' (paid OR free piece): elapsed has reached the stream deadline,
 *     so the pump ends cleanly (→ settle the partial) instead of being killed at
 *     maxDuration → reaped → free.
 * `budgetCredits` undefined ⇒ no cost-abort (off the paid path). A null metered
 * cost counts as 0 credits (never spuriously aborts on budget).
 */
export function sectionalAbortReason(args: {
  budgetCredits: number | undefined
  meteredMicroUsd: number | null
  abortMargin: number
  enforceWallClock: boolean
  elapsedMs: number
  deadlineMs: number
}): 'budget' | 'wall_clock' | undefined {
  if (args.budgetCredits !== undefined) {
    const meteredCredits =
      args.meteredMicroUsd != null ? costToCredits(args.meteredMicroUsd, MARKUP_GENERATE) : 0
    if (meteredCredits >= args.budgetCredits - args.abortMargin) return 'budget'
  }
  if (args.enforceWallClock && args.elapsedMs >= args.deadlineMs) return 'wall_clock'
  return undefined
}

/**
 * SSE responder for the converse handler. Pumps text-delta events to
 * the client as `event: text-delta` frames, persists the accumulated
 * assistant text to the conversation store on message-stop, error, or
 * client-abort. Records token usage to the per-chat budget on stop.
 *
 * Frame format (text/event-stream):
 *   event: header
 *   data: {chatId, toolUseId, model, classification, debug}
 *
 *   event: text-delta
 *   data: {delta: "..."}
 *
 *   event: done
 *   data: {usage, stopReason, finalText}
 *
 * Errors mid-stream emit `event: error` with {code, error}.
 * A `: keepalive` comment frame is sent every ~15s to defeat
 * intermediate proxies.
 */
async function respondWithConverseStream(
  userId: string,
  chatId: string,
  outcome: OrchestratorConverseStream,
  mode: OrchestratorMode,
  generationTier: GenerationTier,
  requestId: string,
  holdId?: string,
  // NB: no `freePiece` param by design — a free piece is from-scratch (no score),
  // but converse requires an existing score, so it falls through (and is refused
  // by the paid/free-piece legacy backstop) rather than ever reaching here. So a
  // free piece never streams a converse and never consumes the grant on a Q&A.
): Promise<Response> {
  const toolUseId = synthToolUseId()
  const keyConfigured = !!process.env.ANTHROPIC_API_KEY
  const debug: ChatDebugPayload = {
    classification: {
      kind: outcome.classification.kind,
      scope: outcome.classification.scope,
      complexity: outcome.classification.complexity,
      confidence: outcome.classification.confidence,
      reason: outcome.classification.reason,
    },
    handler: 'converse',
    model: outcome.model,
    latencyMs: outcome.latencyMs,
    fellThrough: false,
    mode,
    keyConfigured,
    legacyClient: keyConfigured ? 'real' : 'stub',
    keyStatus: computeKeyStatus(),
    generationTier,
  }

  // INSERT a `partial` assistant row BEFORE the stream opens. Three things
  // this buys us:
  //   1. Concurrent `appendMessages` writers see this seq via MAX(seq)+1
  //      and pick higher, instead of racing on `messages_session_seq`.
  //   2. A process crash mid-stream (Vercel timeout, OOM, deploy) leaves a
  //      reapable row instead of vanishing — the janitor flips it to
  //      `errored` and hydration shows "[interrupted]" instead of a
  //      phantom missing turn.
  //   3. Hydration during the stream surfaces it as in-progress / errored,
  //      so a refresh shows the user the row they're seeing on screen.
  //
  // The user turn is persisted UPSTREAM (in `handleChat`) before the
  // orchestrator/LLM call, so we pass [] for precedingMessages here.
  // (Reasoning: a chat-vanish fix — see comment on the early
  // appendMessages call in handleChat.) The streaming row is still
  // written before the stream opens for reasons 1–3 above.
  const { messageId } = await appendStreamingAssistant(userId, chatId, [])

  let accumulated = ''
  let finalized = false
  let holdSettled = false // PR-7b-2: paid-path hold settled at message-stop?
  let keepalive: ReturnType<typeof setInterval> | undefined

  async function finalize(
    status: 'complete' | 'errored',
    errorCode?: string,
    usage?: { inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    if (finalized) return
    finalized = true
    try {
      const { updated } = await finalizeStreamingMessage(
        messageId,
        status === 'errored'
          ? { status, text: accumulated, errorCode: errorCode ?? 'unknown' }
          : { status, text: accumulated },
      )
      if (!updated) {
        // Conditional UPDATE returned 0 rows — the reaper or another
        // finalize beat us. Log and move on; we don't fight a deliberate
        // non-partial state (the reaped 'errored' is the user-correct
        // outcome since by definition some watcher decided we took too long).
        console.warn('[sse-finalize] row already non-partial', {
          chatId,
          messageId,
          attemptedStatus: status,
        })
      }
    } catch (e) {
      console.error('[sse-finalize] failed', { chatId, messageId, error: e })
    }
    if (usage) {
      recordUsage(chatId, usage.inputTokens, usage.outputTokens)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const write = (event: string, data: unknown) => {
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }
      write('header', { chatId, toolUseId, model: outcome.model, debug })
      keepalive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`))
        } catch {
          // Controller closed — interval will be cleared by finally.
        }
      }, 15_000)

      // The model's streamed call fires HERE, as the route pumps the generator —
      // outside run()'s usage-meter scope. Wrap the pump in its own scope so the
      // provider call is metered, then backfill the optimistically-recorded turn
      // (its cost was null at dispatch). recordProviderCall propagates into the
      // generator body because the meter store is active at each `.next()`.
      await runWithUsageMeter(requestId, async () => {
        try {
          for await (const ev of outcome.events) {
            if (ev.type === 'text-delta') {
              accumulated += ev.delta
              write('text-delta', { delta: ev.delta })
            } else if (ev.type === 'message-stop') {
              await finalize(
                'complete',
                undefined,
                ev.usage
                  ? {
                      inputTokens: ev.usage.inputTokens,
                      outputTokens: ev.usage.outputTokens,
                    }
                  : undefined,
              )
              backfillStreamedTurnCost(requestId)
              // PR-7b-2: a COMPLETED converse stream is charged off the now-
              // backfilled cost. The pump runs to message-stop even if the
              // client disconnected (no AbortSignal propagation), so a paid
              // converse is settled exactly once here; release-on-error is the
              // finally below.
              if (holdId) {
                const settle = settleHeldGeneration({
                  holdId,
                  requestId,
                  chatId,
                  generationTier,
                  kind: outcome.classification.kind,
                  model: outcome.model,
                  cost: meterStreamCost(), // streamed cost from the pump meter
                })
                holdSettled = settle.ok
                if (!settle.ok) {
                  console.error('[paywall] converse settle hold_not_active (anomalous; text already delivered)', {
                    requestId,
                    chatId,
                    holdId,
                  })
                }
              }
              write('done', {
                usage: ev.usage,
                stopReason: ev.stopReason,
                finalText: accumulated,
              })
            } else if (ev.type === 'error') {
              await finalize('errored', 'upstream_error')
              // PR-7b-2c: log the raw upstream detail, return a generic message —
              // never echo provider internals to the client (matches the
              // non-streaming path).
              console.error('[chat] converse stream upstream error', {
                chatId,
                requestId,
                error: redactSecrets(ev.error.message),
              })
              write('error', {
                code: 'upstream_error',
                error: 'The model is unavailable right now. Please try again.',
              })
            }
          }
        } catch (e) {
          // Defensive: any other throw (network drop on the iterator) —
          // finalize as errored and report (raw detail logged, generic to client).
          await finalize('errored', 'upstream_error')
          console.error('[chat] converse stream failed', {
            chatId,
            requestId,
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          })
          write('error', {
            code: 'upstream_error',
            error: 'The model is unavailable right now. Please try again.',
          })
        } finally {
          // PR-7b-2: release the hold unless the stream COMPLETED and settled
          // above (error / mid-pump throw → our failure → free). No-op once
          // settled; a process-kill before this leaves the hold for the reaper.
          if (holdId && !holdSettled) safeReleaseHold(holdId, requestId)
          if (keepalive) clearInterval(keepalive)
          try {
            controller.close()
          } catch {
            // Already closed (e.g. client aborted).
          }
        }
      })
    },
    cancel() {
      // Client closed the connection. Finalize as errored (client_abort)
      // instead of complete — the model never said stop, so the next-turn
      // refinement-vs-retry decision should treat this as a failure.
      //
      // PR-7b-2 MONEY INVARIANT: this does NOT cancel the pump — the converse
      // call runs to message-stop server-side (no AbortSignal is threaded into
      // the orchestrator), so a paid hold is SETTLED at message-stop even on
      // disconnect (a real user abort is charged, never refunded). If anyone
      // later wires this cancel() → an AbortSignal that STOPS the generation, the
      // pump exits before settling and the `finally` RELEASES the hold → a
      // delivered-but-free paid generation. Re-derive the settle path first.
      if (keepalive) clearInterval(keepalive)
      void finalize('errored', 'client_abort')
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'X-Orchestrator-Label': 'converse',
    },
  })
}

/**
 * SSE responder for M25-PR-4 streaming sectional generation. Emits a
 * `section` frame as each section completes (the client renders the
 * score growing), persists the final/partial score on `done` (assistant
 * turn + score_versions row + head bump), and maps a fatal `error` to a
 * clean error frame. Keepalives every ~15s defeat intermediate proxies.
 *
 * Sets `X-Stream-Kind: score` so the client selects the score-stream
 * consumer rather than the converse text consumer.
 */
async function respondWithScoreStream(
  userId: string,
  chatId: string,
  outcome: OrchestratorScoreStream,
  mode: OrchestratorMode,
  generationTier: GenerationTier,
  requestId: string,
  holdId?: string,
  freePiece?: boolean,
  // PR-13: the free-piece claim's owner token (from reserveFreePiece), threaded so
  // the in-stream zero-section release un-claims ONLY this request's reservation.
  freePieceToken?: string | null,
  // PR-7b-2c: the placed hold's credit amount = the sectional cost budget. The
  // pump aborts before the metered cost reaches it. 0 / undefined off the paid
  // path (no cost-abort; a free piece is wall-clock-bounded only).
  holdCredits?: number,
): Promise<Response> {
  const keyConfigured = !!process.env.ANTHROPIC_API_KEY
  const debug: ChatDebugPayload = {
    classification: {
      kind: outcome.classification.kind,
      scope: outcome.classification.scope,
      complexity: outcome.classification.complexity,
      confidence: outcome.classification.confidence,
      reason: outcome.classification.reason,
    },
    handler: outcome.classification.kind,
    model: outcome.model,
    latencyMs: outcome.latencyMs,
    fellThrough: false,
    mode,
    keyConfigured,
    legacyClient: keyConfigured ? 'real' : 'stub',
    keyStatus: computeKeyStatus(),
    generationTier,
  }

  // Persist the final (or partial-but-valid) score as the assistant turn
  // and advance the head. Score streams are never gated (no replacement /
  // ghost-preview confirmation on a from-scratch generation).
  async function persist(
    score: Score,
    introText: string,
    toolUseId: string | undefined,
  ): Promise<{ abc: string; toolUseId: string; headVersionId?: string }> {
    validateScore(score)
    const abc = scoreToAbc(score)
    await validateAbc(abc)
    const id = toolUseId ?? synthToolUseId()
    await appendMessages(userId, chatId, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: introText },
          {
            type: 'tool_use',
            id,
            name: RENDER_SCORE_TOOL_NAME,
            input: score as unknown as Record<string, unknown>,
          },
        ],
      },
    ])
    const headVersionId = await readHeadVersionId(chatId)
    return { abc, toolUseId: id, ...(headVersionId !== undefined ? { headVersionId } : {}) }
  }

  let holdSettled = false // PR-7b-2: paid-path hold settled (at `done` or abort)?
  let settledCredits = 0 // captured for refund-on-persist-failure
  let delivered = false // PR-7b-2c: a `done` frame was written (score persisted)?
  let keepalive: ReturnType<typeof setInterval> | undefined

  // PR-7b-2c abort budgets. The COST abort uses the placed hold (paid) OR a fixed
  // free-piece ceiling (a free piece has no hold, so this bounds what we EAT). The
  // WALL-CLOCK applies to any money-adjacent stream (paid OR free piece). The margin
  // keeps a stop-AFTER-a-section's charge within the hold; settleHold's cap is the
  // hard backstop if a section overshoots anyway (we under-earn + page via overHold,
  // never overdraft). On the free piece there is no settle, so the cost-abort purely
  // caps raw spend per run.
  const budgetCredits =
    holdId !== undefined ? holdCredits : freePiece ? freePieceBudgetCredits() : undefined
  const abortMargin = sectionAbortMarginCredits(policyFor('pro').maxOutputTokens)
  const enforceWallClock = holdId !== undefined || freePiece === true
  const streamStartedAt = Date.now()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const write = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Controller closed (client aborted) — keepalive clears in finally.
        }
      }
      write('header', { chatId, model: outcome.model, debug })
      keepalive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`))
        } catch {
          // closed
        }
      }, 15_000)

      // Finalize a (full OR partial-but-valid) sectional score: backfill the
      // metered cost, settle the paid hold against it BEFORE persisting (the cost
      // was incurred regardless of whether persist succeeds), persist the
      // assistant turn, and emit `done`. Shared by the natural `done` event and the
      // PR-7b-2c early-abort path. On a persist failure it refunds a settled charge;
      // the free-piece reservation is released in the finally (driven by
      // `delivered`). Sets holdSettled / settledCredits / delivered.
      const finishStream = async (
        score: Score,
        introText: string,
        toolUseId: string | undefined,
        warnings: string[] | undefined,
        model: string | undefined,
      ): Promise<void> => {
        backfillStreamedTurnCost(requestId)
        // The pump runs to here even on client disconnect (no AbortSignal
        // propagation), so a paid sectional is charged exactly once; the finally
        // releases on any non-finalizing exit.
        if (holdId) {
          const settle = settleHeldGeneration({
            holdId,
            requestId,
            chatId,
            generationTier,
            kind: outcome.classification.kind,
            model: model ?? null,
            cost: meterStreamCost(), // streamed sectional cost from the pump meter
          })
          holdSettled = settle.ok
          if (settle.ok) {
            settledCredits = settle.creditsCharged
          } else {
            console.error('[paywall] score-stream settle hold_not_active (anomalous; sections already delivered)', {
              requestId,
              chatId,
              holdId,
            })
          }
        }
        try {
          const persisted = await persist(score, introText, toolUseId)
          delivered = true // grant stays consumed; the finally won't release it
          write('done', {
            abc: persisted.abc,
            scoreJson: score,
            toolUseId: persisted.toolUseId,
            introText,
            ...(persisted.headVersionId !== undefined ? { headVersionId: persisted.headVersionId } : {}),
            ...(warnings && warnings.length > 0 ? { warnings } : {}),
          })
        } catch (e) {
          // Charged but the final score couldn't be persisted/delivered → refund
          // OUR failure (refund:* key namespaced from settle:*, idempotent,
          // abuse-bounded; return value checked). Raw detail is LOGGED, never
          // echoed to the client (PR-7b-2c SSE sanitize).
          console.error('[chat] score-stream finalize failed', {
            chatId,
            requestId,
            error: e instanceof Error ? e.message : String(e),
          })
          if (holdId && settledCredits > 0) {
            try {
              const r = refund({
                userId,
                requestId,
                holdId,
                credits: settledCredits,
                reason: 'error',
                sessionId: chatId,
                idempotencyKey: `refund:${requestId}:persist_failed`,
              })
              if (!r.ok) {
                console.error('[paywall] score-stream refund after persist failure DENIED — manual reconcile', {
                  requestId,
                  chatId,
                  reason: r.reason,
                })
              }
            } catch (re) {
              console.error('[paywall] score-stream refund after persist failure FAILED — manual reconcile', {
                requestId,
                chatId,
                error: re instanceof Error ? re.message : String(re),
              })
            }
          }
          write('error', {
            code: 'validation_failed' as ChatErrorCode,
            error: 'The generated score could not be finalized. Please try again.',
          })
        }
      }

      // Each sectional sub-call fires HERE as the route pumps the generator —
      // outside run()'s usage-meter scope. Wrap the pump so every section is
      // metered (this is the MOST expensive path — many chained calls), then
      // backfill the optimistically-recorded turn at `done`/abort.
      await runWithUsageMeter(requestId, async () => {
        let lastSectionScore: Score | undefined
        try {
          for await (const ev of outcome.events) {
            if (ev.type === 'section') {
              let abc = ''
              try {
                abc = scoreToAbc(ev.score)
              } catch {
                // A non-renderable interim section: skip the abc, still send
                // progress so the UI advances; the next section supersedes it.
              }
              write('section', {
                sectionIndex: ev.sectionIndex,
                totalSections: ev.totalSections,
                label: ev.label,
                abc,
                scoreJson: ev.score,
              })
              lastSectionScore = ev.score

              // PR-7b-2c cost + wall-clock abort. A sectional has an UNCAPPED section
              // count (only MAX_TOTAL_BARS=512), and each bounded section is a
              // ~constant-input call, so the CUMULATIVE cost grows ~linearly and
              // could settle ABOVE the hold (overHold under-earn) or run past
              // maxDuration → reaped → free. recordProviderCall fires DURING the
              // section call (before the yield), so the meter already includes the
              // section just delivered — the true cost so far. Breaking after a
              // section yield is cost-safe: the generator is suspended BETWEEN calls,
              // so the next (un-run) section's call never fires.
              const abortReason = sectionalAbortReason({
                budgetCredits,
                meteredMicroUsd: meterStreamCost().costMicroUsd,
                abortMargin,
                enforceWallClock,
                elapsedMs: Date.now() - streamStartedAt,
                deadlineMs: SECTIONAL_STREAM_DEADLINE_MS,
              })
              if (abortReason !== undefined && lastSectionScore) {
                console.warn('[paywall] sectional stopped before overspend — settling the partial', {
                  requestId,
                  chatId,
                  reason: abortReason,
                  freePiece: freePiece === true,
                  ...(budgetCredits !== undefined ? { budgetCredits } : {}),
                })
                const warning =
                  abortReason === 'budget'
                    ? holdId !== undefined
                      ? 'Stopped at the credit budget for this generation — ask me to continue to add more sections.'
                      : 'Your free piece is ready. Top up credits to generate longer pieces.'
                    : 'This piece is taking a while to generate — stopped here. Ask me to continue to add more.'
                await finishStream(
                  lastSectionScore,
                  `Composed ${lastSectionScore.measures.length} bars.`,
                  undefined,
                  [warning],
                  outcome.model,
                )
                break
              }
            } else if (ev.type === 'done') {
              await finishStream(ev.score, ev.introText, ev.toolUseId, ev.warnings, ev.model)
            } else {
              write('error', scoreStreamErrorFrame(ev.error))
            }
          }
        } catch (e) {
          console.error('[chat] score stream failed', {
            chatId,
            requestId,
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          })
          write('error', {
            code: 'internal_error' as ChatErrorCode,
            error: 'Something went wrong while generating your score. Please try again.',
          })
        } finally {
          // PR-7b-2: release the hold unless it settled above (error / mid-pump
          // throw → our failure → free). No-op once settled; a process-kill before
          // this leaves it for the reaper.
          if (holdId && !holdSettled) safeReleaseHold(holdId, requestId)
          // PR-7b-2c free-piece consume-on-cost-incurred: release the grant ONLY when
          // NO billable provider call was metered on this stream — the true clean
          // pre-cost failure (meterStreamCost() is null iff callCount===0). Cost is
          // incurred BEFORE the first section: the planner (runPlanScore) AND the seed
          // chunk both fire recordProviderCall in THIS pump scope, so a seed-stage
          // failure that yields `error` with no section has already cost us → KEEP it
          // consumed (releasing would let an induced seed-stage failure re-burn that
          // cost). A delivered piece (delivered=true) keeps it too. Only one of
          // {holdId, freePiece} is ever set.
          if (freePieceToken && !delivered && meterStreamCost().costMicroUsd == null) {
            safeReleaseFreePiece(userId, freePieceToken, requestId)
          }
          if (keepalive) clearInterval(keepalive)
          try {
            controller.close()
          } catch {
            // Already closed.
          }
        }
      })
    },
    cancel() {
      // PR-7b-2 MONEY INVARIANT (see respondWithConverseStream.cancel): the pump
      // is NOT cancelled here, so a paid sectional settles at `done`/abort even on
      // disconnect. Do NOT wire this to an AbortSignal that stops generation
      // without first moving settle off the done/abort path — else the `finally`
      // releases the hold → a delivered-but-free paid generation.
      if (keepalive) clearInterval(keepalive)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'X-Orchestrator-Label': outcome.classification.kind,
      'X-Stream-Kind': 'score',
    },
  })
}

/** Map a fatal score-stream error to a clean, user-facing SSE error frame. */
function scoreStreamErrorFrame(e: Error): { code: ChatErrorCode; error: string } {
  if (e instanceof OutputTruncatedError) {
    return {
      code: 'output_too_large',
      error: 'A section was too dense to generate in one pass. Try a simpler request or fewer bars.',
    }
  }
  if (e instanceof RateLimitedError) {
    return { code: 'rate_limited', error: 'The model is rate-limited right now. Please try again in a minute.' }
  }
  if (e instanceof UpstreamError) {
    return { code: 'upstream_error', error: 'The model is unavailable right now. Please try again.' }
  }
  return { code: 'internal_error', error: 'Something went wrong while generating your score. Please try again.' }
}

export const UuidSchema = z.string().uuid()

/**
 * Map the native Anthropic-shaped transcript into the compact, panel-
 * facing TranscriptTurn[]. Schema-violating turns (e.g. an assistant
 * tool_use whose input doesn't parse as Score) are dropped with a
 * console warn rather than failing the whole GET — defensive against
 * stub data or pre-schema legacy.
 */
function mapTranscriptToTurns(transcript: Conversation): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let anyPriorToolUse = false

  for (const message of transcript) {
    if (message.role === 'user') {
      const textBlock = message.content.find((c) => c.type === 'text')
      const text = textBlock && 'text' in textBlock ? textBlock.text : ''
      if (!anyPriorToolUse) {
        turns.push({ role: 'user', kind: 'text', text })
      } else {
        const toolResult = message.content.find((c) => c.type === 'tool_result') as
          | { type: 'tool_result'; tool_use_id: string; content: string }
          | undefined
        if (!toolResult) {
          // Should not happen for refinement turns produced by this route,
          // but be defensive — skip rather than poison the transcript.
          continue
        }
        turns.push({
          role: 'user',
          kind: 'refinement',
          text,
          hadEdit:
            typeof toolResult.content === 'string' && toolResult.content.trim().length > 0,
          toolUseId: toolResult.tool_use_id,
        })
      }
      continue
    }

    // assistant
    let introText: string | undefined
    let toolUseId: string | undefined
    let scoreInput: unknown
    let hasToolUse = false
    for (const block of message.content) {
      if (block.type === 'text') introText = block.text
      else if (block.type === 'tool_use') {
        hasToolUse = true
        toolUseId = block.id
        scoreInput = block.input
      }
    }

    // Surface non-complete streaming-message state (`partial` reaped by the
    // janitor, or stream errored / client-aborted mid-flight). Render as
    // a text turn with `errored: true` so the client shows "[interrupted]"
    // rather than a phantom successful response. ConversationMessage._meta
    // is only attached for non-`complete` rows, so any defined streamStatus
    // here is errored or partial.
    if (message._meta?.streamStatus) {
      const fallback = '[interrupted]'
      turns.push({
        role: 'assistant',
        kind: 'text',
        text: introText && introText.length > 0 ? introText : fallback,
        toolUseId: `toolu_orch_text_${turns.length}`,
        errored: true,
        ...(message._meta?.errorCode ? { errorCode: message._meta.errorCode } : {}),
      })
      continue
    }

    // Text-only assistant turn (converse handler output).
    if (!hasToolUse) {
      if (!introText) continue
      turns.push({
        role: 'assistant',
        kind: 'text',
        text: introText,
        // Mint a stable synthetic id so optimistic + server-mapped turns
        // can be reconciled. Real Anthropic ids never reach this branch.
        toolUseId: `toolu_orch_text_${turns.length}`,
      })
      continue
    }

    if (!toolUseId) continue
    const parsed = ScoreSchema.safeParse(scoreInput)
    if (!parsed.success) {
      console.warn('mapTranscriptToTurns: skipping assistant turn with invalid score', parsed.error.issues)
      continue
    }
    turns.push({
      role: 'assistant',
      kind: 'render_score',
      introText,
      scoreSummary: summarizeScore(parsed.data),
      toolUseId,
      scoreHash: scoreHash(parsed.data),
    })
    anyPriorToolUse = true
  }

  return turns
}

/**
 * Returns the panel-facing transcript for a chat. 404 (not 410 like
 * POST) for unknown chatIds — GET is a read, REST convention.
 */
export async function GET(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const url = new URL(request.url)
  const chatId = url.searchParams.get('chatId')
  if (!chatId) {
    return errorResponse('invalid_request', 400, 'Missing chatId query parameter')
  }
  const parsed = UuidSchema.safeParse(chatId)
  if (!parsed.success) {
    return errorResponse('invalid_request', 400, 'Invalid chatId format')
  }
  const session = await getRequestUser()
  const { userId } = session
  const transcript = await getConversation(userId, chatId)
  if (!transcript) {
    // Single scoped query — handles both "never existed" and
    // "deleted by another tab between hasConversation and read" in
    // one path. No TOCTOU window vs. the prior two-call pattern.
    return errorResponse('chat_not_found', 404, 'Chat session not found')
  }

  // Hydration: also pull the head score so a sidebar switch can
  // restore the editor in one roundtrip. Extracted directly from the
  // transcript (the most recent assistant tool_use that parses as a
  // Score) so we don't need a separate DB lookup against score_versions.
  const head = await extractHeadScore(userId, chatId, transcript)
  const versions = head?.headVersionId
    ? await extractVersionChain(head.headVersionId)
    : undefined
  const body: TranscriptResponse = {
    chatId,
    turns: mapTranscriptToTurns(transcript),
    ...(head ?? {}),
    ...(versions ? { versions } : {}),
  }
  return attachRecoveryHeader(NextResponse.json(body), session)
}

/**
 * Walk `parent_version_id` from the given head back to root via a
 * single recursive CTE, capped at 50 entries (matches HISTORY_CAP in
 * src/lib/chat/state.ts). Returns oldest→head order so the client can
 * use it as `history[]` directly with `historyPointer = length-1`.
 *
 * A bad row in the middle of the chain (corrupt JSON, missing
 * parent_version_id pointer that doesn't exist) stops the walk early
 * — better to surface a shorter-than-real chain than to crash the
 * hydration roundtrip.
 */
async function extractVersionChain(
  headVersionId: string,
): Promise<VersionEntry[] | undefined> {
  try {
    const { getDb } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    const db = getDb()
    type Row = {
      id: string
      parent_version_id: string | null
      score_json: string
      source: string
      created_at: number
      depth: number
    }
    const rows = db.all(sql`
      WITH RECURSIVE chain(id, parent_version_id, score_json, source, created_at, depth) AS (
        SELECT id, parent_version_id, score_json, source, created_at, 0
        FROM score_versions
        WHERE id = ${headVersionId}
        UNION ALL
        SELECT sv.id, sv.parent_version_id, sv.score_json, sv.source, sv.created_at, c.depth + 1
        FROM score_versions sv
        JOIN chain c ON sv.id = c.parent_version_id
        WHERE c.depth < 49
      )
      SELECT id, parent_version_id, score_json, source, created_at, depth
      FROM chain
      ORDER BY depth DESC
    `) as Row[]
    const out: VersionEntry[] = []
    for (const r of rows) {
      let parsedScore: unknown
      try {
        parsedScore = JSON.parse(r.score_json)
      } catch {
        break // corrupt row — return whatever we have so far
      }
      const parsed = ScoreSchema.safeParse(parsedScore)
      if (!parsed.success) break
      if (
        r.source !== 'llm' &&
        r.source !== 'edit' &&
        r.source !== 'import' &&
        r.source !== 'fork-seed' &&
        r.source !== 'revert'
      ) {
        // Unexpected source — defensive; shouldn't happen given the CHECK constraint.
        break
      }
      out.push({
        id: r.id,
        parentVersionId: r.parent_version_id ?? null,
        scoreJson: parsed.data,
        source: r.source,
        createdAt: r.created_at,
      })
    }
    return out
  } catch {
    return undefined
  }
}

/**
 * Resolve the session's current head score for hydration. Prefers the
 * `score_versions[head_version_id]` row (which reflects user edits
 * persisted via /api/sessions/:id/versions) over the transcript scan
 * — without this, a refresh after manual editing would silently lose
 * the visible edit (the row is still in the DB; it just doesn't
 * surface).
 *
 * toolUseId + introText always come from the transcript scan because
 * edits don't have either — but they're needed for fork-from-history
 * and for the "Restored" intro display, so we walk back to the last
 * LLM `render_score` for those.
 *
 * Returns undefined when the session has no LLM-generated score yet
 * (newly created, converse-only, etc.) — the caller spreads
 * conditionally.
 */
async function extractHeadScore(
  userId: string,
  chatId: string,
  transcript: Conversation,
): Promise<
  | {
      currentScore: Score
      currentAbc: string
      currentToolUseId: string
      currentIntroText?: string
      headVersionId?: string
    }
  | undefined
> {
  // 1. Find the latest assistant render_score in the transcript — we
  //    need its toolUseId and introText regardless of whether the head
  //    has moved past it via edits. Skip rows with non-complete
  //    stream_status — those rows never carry a tool_use (the converse
  //    handler is text-only), but defense-in-depth costs nothing here.
  let toolUseId: string | undefined
  let introText: string | undefined
  let llmScoreInput: unknown
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i]
    if (msg.role !== 'assistant') continue
    if (msg._meta?.streamStatus) {
      // Non-complete row; never has tool_use anyway.
      continue
    }
    for (const block of msg.content) {
      if (block.type === 'text') introText = block.text
      else if (block.type === 'tool_use') {
        toolUseId = block.id
        llmScoreInput = block.input
      }
    }
    if (toolUseId) break
  }
  if (!toolUseId || llmScoreInput === undefined) return undefined

  // 2. Resolve the actual head score: prefer the DB's head_version_id
  //    (will reflect any persisted edits); fall back to the transcript's
  //    LLM checkpoint when no head row exists.
  let scoreInput: unknown = llmScoreInput
  let headVersionId: string | undefined
  try {
    const { getDb } = await import('@/lib/db')
    const { sessions: sessionsTable, scoreVersions: scoreVersionsTable } =
      await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const db = getDb()
    const session = await db
      .select({ head: sessionsTable.headVersionId })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, chatId))
      .limit(1)
      .get()
    headVersionId = session?.head ?? undefined
    if (headVersionId) {
      const version = await db
        .select({ scoreJson: scoreVersionsTable.scoreJson })
        .from(scoreVersionsTable)
        .where(eq(scoreVersionsTable.id, headVersionId))
        .limit(1)
        .get()
      if (version) {
        try {
          scoreInput = JSON.parse(version.scoreJson)
        } catch {
          // Corrupted row — fall back to llmScoreInput silently.
        }
      }
    }
  } catch {
    // Non-fatal — fall back to transcript-scan score.
  }

  const parsed = ScoreSchema.safeParse(scoreInput)
  if (!parsed.success) return undefined
  let abc: string
  try {
    abc = scoreToAbc(parsed.data)
  } catch {
    return undefined
  }
  return {
    currentScore: parsed.data,
    currentAbc: abc,
    currentToolUseId: toolUseId,
    currentIntroText: introText,
    headVersionId,
  }
}

/** Reset endpoint: clears the conversation server-side. Returns 204 even
 *  if the chatId is unknown (idempotent). */
export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const chatId = url.searchParams.get('chatId')
  if (!chatId) {
    return errorResponse('invalid_request', 400, 'Missing chatId query parameter')
  }
  const parsed = UuidSchema.safeParse(chatId)
  if (!parsed.success) {
    return errorResponse('invalid_request', 400, 'Invalid chatId format')
  }
  const session = await getRequestUser()
  await deleteConversation(session.userId, chatId)
  return attachRecoveryHeader(new NextResponse(null, { status: 204 }), session)
}
