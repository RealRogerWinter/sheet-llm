import { recordTurn, type RecordTurnFields } from './observability'
import { checkCopyright } from './copyright/filter'
import { classify, ClassifierSchemaError } from './classifier'
import { isDeadlineApproaching } from './deadline'
import { runEditScoreLevel, EditHandlerError } from './handlers/editScoreLevel'
import { runEditIntraMeasure, EditIntraMeasureError } from './handlers/editIntraMeasure'
import { runGenerateSimple } from './handlers/generateSimple'
import { runGenerateComplex } from './handlers/generateComplex'
import { runGenerateBounded } from './handlers/generateBounded'
import { runGenerateSectionalStream } from './handlers/generateSectional'
import { runCompose } from './handlers/compose'
import { runConverse } from './handlers/converse'
import { runRefuse } from './handlers/refuse'
import { runExtendComposition, ExtendCompositionError } from './handlers/extendComposition'
import { runInsertMeasures, InsertMeasuresError } from './handlers/insertMeasures'
import { runRegionReplace, RegionReplaceError } from './handlers/regionReplace'
import {
  isBoundedGenEnabled,
  isGhostPreviewEnabled,
  isNewToolDispatchEnabled,
  isReplacementGateEnabled,
  isSectionalGenEnabled,
} from './flags'
import { policyFor } from './generationTier'
import { detectReplacement, type DispatchToolName } from './replacementDetect'
import { computeAffectedEventIds, scoreDiff } from '@/lib/music/scoreDiff'
import { ensureEventIds } from '@/lib/music/eventIds'
import {
  run as toolDispatchRun,
  ToolDispatchError,
  type DispatchDecision,
} from './toolDispatch'
import { RateLimitedError, UpstreamError } from '@/lib/llm/errors'
import { OutputTruncatedError, ProviderSchemaError } from '@/lib/providers/types'
import { ValidationError } from '@/lib/music/errors'
import type {
  Classification,
  FallThroughReason,
  OrchestratorFallThrough,
  OrchestratorInput,
  OrchestratorRefusal,
  OrchestratorResult,
  OrchestratorRunOutcome,
  TaskKind,
} from './types'
import { isOrchestratorConverseStream, isOrchestratorScoreStream } from './types'

const CONFIDENCE_FLOOR = 0.6
/** Rough wall-clock estimates for deadline guards. PR B will
 *  replace these with per-provider estimates from the registry. */
const CLASSIFIER_ESTIMATED_MS = 2_000
const HANDLER_ESTIMATED_MS = 8_000

function isResult(o: OrchestratorRunOutcome): o is OrchestratorResult {
  return (
    o !== null &&
    !('refused' in o) &&
    !('fellThrough' in o) &&
    !isOrchestratorConverseStream(o)
  )
}

/**
 * M3.5-PR-4 — read sessions.replacement_gate_suppressed. Returns false
 * on any DB error or unknown session id — defense-in-depth: if we
 * can't tell, we err on the side of running the gate.
 *
 * Dynamic import keeps the orchestrator usable in pure-node test
 * harnesses that don't bother spinning up a DB (the gate falls back
 * to "not suppressed" and runs normally).
 */
async function isReplacementGateSuppressed(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId || sessionId === 'anonymous') return false
  try {
    const { getDb } = await import('@/lib/db')
    const { sessions } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const row = await getDb()
      .select({ s: sessions.replacementGateSuppressed })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .get()
    return row?.s === 1
  } catch {
    return false
  }
}

/**
 * M3.5-PR-4 — replacement-as-confirmation gate hook. Inspects the
 * (before, after, userText, dispatchTool) tuple and mutates the
 * result IN PLACE when the gate fires:
 *   - sets `requiresConfirmation: true`
 *   - attaches `replacement: { retainedIdentityRatio, reasons }`
 *
 * The route (api/chat) checks `requiresConfirmation` and gates head-
 * pointer persistence + surfaces a modal to the user instead of
 * silently swapping the score.
 *
 * Gated behind `SL_REPLACEMENT_GATE` env var (default ON). Per-session
 * suppression via `sessions.replacement_gate_suppressed` short-circuits
 * the gate for one session.
 *
 * Returns the `replacementBlocked` flag so `recordTurn` can persist the
 * telemetry on the same row.
 */
async function maybeApplyReplacementGate(
  result: OrchestratorResult,
  input: OrchestratorInput,
): Promise<boolean> {
  if (!isReplacementGateEnabled()) return false
  if (!input.editedScore) return false
  if (await isReplacementGateSuppressed(input.chatId)) return false

  // The dispatcher's confirmExplicitRewrite flag is implicit in
  // dispatchTool === 'regenerate_all': PR-3 only reaches the apply
  // branch when the flag was true (preview-mode result is returned
  // otherwise). For the legacy path, dispatchTool is undefined and the
  // gate falls back to the user-text keyword scan.
  const confirmExplicitRewrite = result.dispatchTool === 'regenerate_all' ? true : undefined

  const decision = detectReplacement({
    beforeScore: input.editedScore,
    afterScore: result.score,
    userText: input.userText,
    ...(result.dispatchTool !== undefined
      ? { dispatchTool: result.dispatchTool as DispatchToolName }
      : {}),
    ...(confirmExplicitRewrite !== undefined ? { confirmExplicitRewrite } : {}),
  })

  if (!decision.isReplacement) return false

  result.requiresConfirmation = true
  result.replacement = {
    retainedIdentityRatio: decision.retainedIdentityRatio,
    reasons: decision.reasons,
  }
  return true
}

/**
 * M24-PR-2 — AI ghost preview hook. Attaches a `proposal: { affectedEventIds }`
 * payload + sets `requiresConfirmation: true` so the route gates the
 * head-version bump. The client then renders an inline overlay or
 * docked panel and lets the user accept / reject.
 *
 * Mutually exclusive with the replacement gate — runs AFTER it. The
 * replacement gate has its own modal UX with "don't ask again" that we
 * don't replicate in the proposal flow; if it's already firing, the
 * ghost preview defers.
 *
 * No-op when:
 *   - `SL_GHOST_PREVIEW` is off (default in PR-2; PR-6 flips on)
 *   - no editedScore (compose-from-scratch — nothing to preview against)
 *   - replacement gate already fired (modal owns the UX)
 *   - `requiresConfirmation` already set (preview-mode regenerate_all)
 *   - the result score is functionally identical to editedScore (no
 *     meaningful diff to preview — silent commit is correct)
 */
function maybeAttachGhostProposal(
  result: OrchestratorResult,
  input: OrchestratorInput,
): void {
  if (!isGhostPreviewEnabled()) return
  if (!input.editedScore) return
  if (result.replacement) return
  if (result.requiresConfirmation === true) return
  const diff = scoreDiff(input.editedScore, result.score)
  const noDiff =
    diff.retainedEventRatio === 1 &&
    diff.measureCountBefore === diff.measureCountAfter &&
    diff.keyChanged === false &&
    diff.meterChanged === false &&
    diff.titleChanged === false
  if (noDiff) return
  // The overlay/diff locate the changed notes BY EVENT ID. Orchestrator
  // results don't carry ids (`id` is optional and only backfilled on the
  // migrate-on-load path), so without this `computeAffectedEventIds`
  // returns [] and nothing highlights. Backfill ids on the candidate
  // first — deterministic + idempotent (deriveEventId), and ids never
  // appear in the ABC so the rendered notation is unchanged.
  ensureEventIds(result.score)
  result.proposal = {
    affectedEventIds: computeAffectedEventIds(input.editedScore, result.score),
  }
  result.requiresConfirmation = true
}

/**
 * M26 follow-up — recordTurn wrapper that stamps every orchestrator turn with
 * the resolved product tier from `input` (`free` / `pro`). All recordTurn call
 * sites in this module go through this so the turn logs show which tier each
 * request ran under. (Declared as a function so it hoists above the callers.)
 */
function recordTurnT(input: OrchestratorInput, fields: RecordTurnFields): Promise<void> {
  return recordTurn(
    input.generationTier ? { ...fields, generationTier: input.generationTier } : fields,
  )
}

function fallThrough(
  reason: FallThroughReason,
  latencyMs: number,
  opts: { classification?: Classification; errorMessage?: string } = {},
): OrchestratorFallThrough {
  return {
    fellThrough: true,
    reason,
    latencyMs,
    ...(opts.classification ? { classification: opts.classification } : {}),
    ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
  }
}

/**
 * Dispatch a classified request to its handler. Handlers that can't
 * run (edit_intra_measure in Phase 1, generate_complex/compose in
 * Phases <3) return null so the route falls through to the legacy
 * single-shot Sonnet path.
 */
async function dispatch(
  classification: Classification,
  input: OrchestratorInput,
): Promise<OrchestratorRunOutcome> {
  switch (classification.kind) {
    case 'edit_score_level':
      return runEditScoreLevel({ classification, editedScore: input.editedScore })

    case 'generate_simple':
      return runGenerateSimple({ classification, history: input.history })

    case 'refuse':
      return runRefuse({ classification, refusalCode: 'out_of_scope' })

    case 'edit_intra_measure':
      return runEditIntraMeasure({
        classification,
        editedScore: input.editedScore,
        modelOverride: input.modelOverride,
      })

    case 'generate_complex':
      // M25: route fresh, from-scratch generation through the sectional
      // pipeline when enabled, so large pieces never truncate. With an
      // editedScore present (rare on this path — dispatch handles edits)
      // fall back to the single-shot handler, which folds the prior score in.
      if (isSectionalGenEnabled() && !input.editedScore) {
        return runGenerateSectionalStream({
          classification,
          chatId: input.chatId ?? 'anonymous',
          userText: input.userText,
          ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
          ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
        })
      }
      return runGenerateComplex({
        classification,
        chatId: input.chatId ?? 'anonymous',
        userText: input.userText,
        modelOverride: input.modelOverride,
      })

    case 'compose':
      return runCompose({
        classification,
        chatId: input.chatId ?? 'anonymous',
        userText: input.userText,
        editedScore: input.editedScore,
        modelOverride: input.modelOverride,
      })

    case 'converse': {
      // Defensive: classifier should refuse when no score exists, but
      // if it slips through (e.g. operator-edited prompt) fall through
      // rather than crash mid-stream.
      if (!input.editedScore) {
        return fallThrough('handler_error', 0, {
          classification,
          errorMessage: 'converse dispatched without a score in session',
        })
      }
      return runConverse({
        classification,
        chatId: input.chatId ?? 'anonymous',
        userText: input.userText,
        editedScore: input.editedScore,
        history: input.history,
        modelOverride: input.modelOverride,
        apiKeyOverride: input.apiKeyOverride,
      })
    }

    case 'fall_through':
      return null
  }
}

/**
 * M3.5-PR-3 — translate a DispatchDecision into a handler invocation +
 * result envelope. Each picked tool maps to a handler:
 *   extend_composition  → runExtendComposition
 *   insert_measures     → runInsertMeasures
 *   region_replace      → runRegionReplace
 *   edit_intra_measure  → runEditIntraMeasure (target_description)
 *   regenerate_all      → runCompose (only when confirmExplicitRewrite=true)
 *
 * The function records the orchestrator turn on success/error and
 * returns the typed outcome the caller expects.
 */
async function runDispatchedHandler(
  decision: DispatchDecision,
  input: OrchestratorInput,
  t0: number,
): Promise<OrchestratorRunOutcome> {
  // Build a synthetic Classification carrying the picked tool so
  // downstream confirmation-text + observability code can use familiar
  // semantics. The kind maps loosely; for the new structural tools we
  // tag them as 'compose' to match the most-similar existing handler
  // taxonomy.
  const syntheticClassification: Classification = {
    kind:
      decision.tool === 'edit_intra_measure'
        ? 'edit_intra_measure'
        : decision.tool === 'answer_question'
          ? 'converse'
          : decision.tool === 'regenerate_all'
            ? 'compose'
            : 'compose',
    scope: 'short',
    complexity: 'complex',
    confidence: decision.confidence,
  }

  // M26 follow-up — free-tier scope gate. The free policy bounds output to
  // small, localized edits; the whole-score rewrite (regenerate_all) is
  // Pro-only, and structural growth (extend / insert) is clamped to the tier's
  // bar budget below. This enforces the policy flags that were defined but
  // previously unread, so a free-tier refine can't run an unbounded generation.
  const policy = policyFor(input.generationTier ?? 'free')
  if (!policy.allowWholeScore && decision.tool === 'regenerate_all') {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'compose',
      handler: 'paywall',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'refused',
      confidence: decision.confidence,
      error: 'tier_gated: regenerate_all is pro-only',
      beforeScore: input.editedScore,
    })
    return runRefuse({
      classification: { ...syntheticClassification, kind: 'compose' },
      refusalCode: 'pro_only',
      reason:
        'Regenerating the whole score from scratch is a Pro feature. Switch to Pro (debug panel → Paywall mode → off), or ask for a smaller change — up to 4 bars at a time.',
    })
  }

  // Compute deadline-budget for the handler call.
  if (
    input.deadlineAt !== undefined &&
    isDeadlineApproaching(input.deadlineAt, HANDLER_ESTIMATED_MS)
  ) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: syntheticClassification.kind as TaskKind,
      handler: 'deadline',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      confidence: decision.confidence,
      error: 'deadline_exceeded',
      beforeScore: input.editedScore,
    })
    return fallThrough('deadline_exceeded', Date.now() - t0, {
      classification: syntheticClassification,
    })
  }

  try {
    if (decision.tool === 'answer_question') {
      // Read-only Q&A path. The dispatcher recognized a question about
      // the score (music theory / analysis / "what's happening") rather
      // than an edit. Route to the converse handler, which streams a
      // markdown answer. This returns an OrchestratorConverseStream — NOT
      // a score result — so it intentionally bypasses
      // finalizeDispatchResult and the replacement + ghost-preview gates:
      // there is no score mutation to verify or confirm.
      const args = decision.args as { question: string }
      const converseClassification: Classification = {
        ...syntheticClassification,
        kind: 'converse',
        scope: 'snippet',
        complexity: 'simple',
        question: args.question,
      }
      const stream = runConverse({
        classification: converseClassification,
        chatId: input.chatId ?? 'anonymous',
        userText: input.userText,
        editedScore: input.editedScore!,
        history: input.history,
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      })
      // The route owns the stream lifecycle (token usage is recorded on
      // message-stop); log the turn optimistically as ok, mirroring the
      // legacy classifier converse path in run().
      await recordTurnT(input, {
        requestId: input.requestId,
        sessionId: input.chatId,
        label: 'converse' as TaskKind,
        handler: 'converse',
        model: stream.model,
        latencyMs: Date.now() - t0,
        finalStatus: 'ok',
        confidence: decision.confidence,
        beforeScore: input.editedScore,
      })
      return stream
    }
    if (decision.tool === 'extend_composition') {
      const args = decision.args as { targetBars: number; hint?: string }
      // Free tier: clamp growth to the tier's bar budget (4) so one refine
      // can't balloon into a long, slow, costly generation. Pro's budget (64)
      // leaves normal extends untouched.
      const targetBars = Math.min(args.targetBars, policy.maxBars)
      const result = await runExtendComposition({
        classification: syntheticClassification,
        editedScore: input.editedScore!,
        userText: input.userText,
        targetBars,
        ...(args.hint !== undefined ? { hint: args.hint } : {}),
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      })
      if (targetBars < args.targetBars) {
        result.warnings = [
          ...(result.warnings ?? []),
          `Free tier adds up to ${policy.maxBars} bars at a time — added ${targetBars} of the ${args.targetBars} requested. Switch to Pro for longer sections.`,
        ]
      }
      return finalizeDispatchResult(result, input, t0, decision)
    }
    if (decision.tool === 'insert_measures') {
      const args = decision.args as {
        afterMeasureIdx: number
        count: number
        hint?: string
      }
      // Free tier: clamp inserted-bar count to the tier budget (see extend).
      const count = Math.min(args.count, policy.maxBars)
      const result = await runInsertMeasures({
        classification: syntheticClassification,
        editedScore: input.editedScore!,
        userText: input.userText,
        afterMeasureIdx: args.afterMeasureIdx,
        count,
        ...(args.hint !== undefined ? { hint: args.hint } : {}),
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      })
      if (count < args.count) {
        result.warnings = [
          ...(result.warnings ?? []),
          `Free tier inserts up to ${policy.maxBars} bars at a time — inserted ${count} of the ${args.count} requested. Switch to Pro for more.`,
        ]
      }
      return finalizeDispatchResult(result, input, t0, decision)
    }
    if (decision.tool === 'region_replace') {
      const args = decision.args as {
        startMeasureIdx: number
        endMeasureIdx: number
        hint: string
      }
      const result = await runRegionReplace({
        classification: syntheticClassification,
        editedScore: input.editedScore!,
        userText: input.userText,
        startMeasureIdx: args.startMeasureIdx,
        endMeasureIdx: args.endMeasureIdx,
        hint: args.hint,
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      })
      return finalizeDispatchResult(result, input, t0, decision)
    }
    if (decision.tool === 'edit_intra_measure') {
      const args = decision.args as { targetDescription: string }
      const intraClass: Classification = {
        ...syntheticClassification,
        kind: 'edit_intra_measure',
        target_description: args.targetDescription,
      }
      const result = await runEditIntraMeasure({
        classification: intraClass,
        editedScore: input.editedScore,
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
      })
      return finalizeDispatchResult(result, input, t0, decision)
    }
    if (decision.tool === 'regenerate_all') {
      const args = decision.args as { confirmExplicitRewrite: true; justification: string }
      // The zod schema enforces confirmExplicitRewrite must be true,
      // but defense-in-depth: if it ever leaks through false, return
      // a previewMode confirmation payload instead of applying.
      if (!args.confirmExplicitRewrite) {
        const previewResult: OrchestratorResult = {
          score: input.editedScore!,
          classification: syntheticClassification,
          model: decision.model,
          latencyMs: Date.now() - t0,
          dispatchTool: 'regenerate_all',
          previewMode: true,
          requiresConfirmation: true,
          warnings: [
            'Dispatcher picked regenerate_all without an explicit rewrite signal — returning preview-mode result rather than applying.',
          ],
        }
        // Preview-mode is its own gate; the replacement-confirmation
        // gate doesn't fire on top of it (already an explicit confirm).
        await recordTurnForResult(previewResult, input, t0, decision, false)
        return previewResult
      }
      const result = await runCompose({
        classification: { ...syntheticClassification, kind: 'compose' },
        chatId: input.chatId ?? 'anonymous',
        userText: input.userText,
        editedScore: input.editedScore,
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
      })
      void args
      return finalizeDispatchResult(
        { ...result, dispatchTool: 'regenerate_all' as const },
        input,
        t0,
        decision,
      )
    }
  } catch (e) {
    const reason: FallThroughReason =
      e instanceof EditHandlerError ||
      e instanceof EditIntraMeasureError ||
      e instanceof ExtendCompositionError ||
      e instanceof InsertMeasuresError ||
      e instanceof RegionReplaceError
        ? 'handler_error'
        : 'classifier_threw'
    const errorMessage = e instanceof Error ? e.message : 'unknown'
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: syntheticClassification.kind as TaskKind,
      handler: 'dispatch',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      confidence: decision.confidence,
      error: `${reason}: ${errorMessage}`,
      beforeScore: input.editedScore,
    })
    return fallThrough(reason, Date.now() - t0, {
      classification: syntheticClassification,
      errorMessage,
    })
  }

  // Unreachable — exhaustive over DispatchToolName.
  throw new Error(`Unknown dispatch tool: ${(decision as { tool: string }).tool}`)
}

async function finalizeDispatchResult(
  result: OrchestratorResult,
  input: OrchestratorInput,
  t0: number,
  decision: DispatchDecision,
): Promise<OrchestratorResult> {
  const out: OrchestratorResult = { ...result, latencyMs: Date.now() - t0 }
  const replacementBlocked = await maybeApplyReplacementGate(out, input)
  maybeAttachGhostProposal(out, input)
  await recordTurnForResult(out, input, t0, decision, replacementBlocked)
  return out
}

async function recordTurnForResult(
  result: OrchestratorResult,
  input: OrchestratorInput,
  t0: number,
  decision: DispatchDecision,
  replacementBlocked: boolean,
): Promise<void> {
  await recordTurnT(input, {
    requestId: input.requestId,
    sessionId: input.chatId,
    label: result.classification.kind as TaskKind,
    handler: result.classification.kind as TaskKind,
    model: result.model,
    latencyMs: Date.now() - t0,
    finalStatus: 'ok',
    confidence: decision.confidence,
    beforeScore: input.editedScore,
    afterScore: result.score,
    appliedOpsCount: result.appliedOps?.length,
    // Broadened semantics: when the new dispatch path runs, reuse the
    // composePatchDispatch column to record the picked tool. Future
    // migrations may rename this to dispatch_tool; for now it's a
    // string-shaped column already.
    ...(result.dispatchTool !== undefined
      ? { composePatchDispatch: result.dispatchTool }
      : {}),
    replacementBlocked,
  })
}

/**
 * Orchestrator entry point. Returns:
 *   OrchestratorResult — caller uses it instead of the legacy LLM path
 *   OrchestratorRefusal — caller returns 422 with the structured reason
 *   null                — caller falls through to the legacy path
 *
 * Failure isolation: any unexpected exception from copyright filter,
 * classifier (schema), or handler degrades to null (fall-through)
 * rather than propagating. The legacy path is always the safety net.
 */
export async function run(input: OrchestratorInput): Promise<OrchestratorRunOutcome> {
  const t0 = Date.now()
  // Mode gating is the caller's job (route.ts honors env + debug
  // overrides + kill switch). Once we're here, we run.

  // Deadline guard — bail before the classifier if we can't plausibly
  // finish. Saves the user from a 504 cascade on slow local models.
  if (
    input.deadlineAt !== undefined &&
    isDeadlineApproaching(input.deadlineAt, CLASSIFIER_ESTIMATED_MS)
  ) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'fall_through',
      handler: 'deadline',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      error: 'deadline_exceeded',
      beforeScore: input.editedScore,
    })
    return fallThrough('deadline_exceeded', Date.now() - t0)
  }

  // Copyright filter — synchronous, no LLM call.
  const copyright = checkCopyright(input.userText)
  if (copyright.blocked) {
    const refusal = runRefuse({
      classification: {
        kind: 'refuse',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 1,
        reason: copyright.reason,
      },
      refusalCode: 'copyright',
      reason: copyright.reason,
    })
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'refuse',
      handler: 'copyrightFilter',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'refused',
      beforeScore: input.editedScore,
    })
    return refusal
  }

  // M26 — free-tier bounded generation choke point. A fresh from-scratch
  // generation on the `free` product tier is served by ONE bounded render_score
  // call (<=4 bars grand staff, tight max_tokens kill-switch, no planner /
  // sectional loop). This sits BEFORE both the native-dispatch branch and
  // classify() on purpose: a fresh prompt can classify as generate_simple /
  // generate_complex / compose, AND vague prompts fall through at the
  // confidence floor — so a gate in any single dispatch arm would leak. This
  // one pre-dispatch seam catches every fresh-generation path. Edits
  // (editedScore present) skip it and keep their own handlers.
  const genPolicy = policyFor(input.generationTier ?? 'free')
  if (genPolicy.tier === 'free' && !input.editedScore && isBoundedGenEnabled()) {
    try {
      const bounded = await runGenerateBounded({
        classification: { kind: 'generate_complex', scope: 'short', complexity: 'simple', confidence: 1 },
        chatId: input.chatId ?? 'anonymous',
        userText: input.userText,
        maxOutputTokens: genPolicy.maxOutputTokens,
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      })
      const result: OrchestratorResult = { ...bounded, latencyMs: Date.now() - t0 }
      await recordTurnT(input, {
        requestId: input.requestId,
        sessionId: input.chatId,
        label: 'generate_complex',
        handler: 'generateBounded',
        model: result.model,
        latencyMs: result.latencyMs,
        finalStatus: 'ok',
        confidence: 1,
        afterScore: result.score,
        appliedOpsCount: result.appliedOps?.length,
      })
      return result
    } catch (e) {
      // The 2600 ceiling firing throws OutputTruncatedError; GenerateBoundedError
      // covers the soft session-budget guard; transient provider errors propagate.
      // All ride the route's existing typed mappings (OutputTruncated -> 422). We
      // record the cut-off reason as a greppable killReason: token on the error
      // column so operators can see WHY any free request was shut off.
      const errMsg = e instanceof Error ? e.message : 'unknown'
      const killReason = e instanceof Error ? e.name : 'unknown'
      await recordTurnT(input, {
        requestId: input.requestId,
        sessionId: input.chatId,
        label: 'generate_complex',
        handler: 'generateBounded',
        model: null,
        latencyMs: Date.now() - t0,
        finalStatus: 'error',
        confidence: 1,
        error: `killReason: ${killReason}: ${errMsg}`,
        beforeScore: input.editedScore,
      })
      throw e
    }
  }

  // M3.5-PR-3 — native tool-use dispatch path. When enabled (and we
  // have an editedScore to reason about), call the dispatcher LLM
  // first; it picks the right handler with full prompt + score context
  // and emits validated args. Otherwise fall through to the legacy
  // classifier path. PR-6 flips the default on.
  if (input.editedScore && isNewToolDispatchEnabled()) {
    let decision: DispatchDecision
    try {
      decision = await toolDispatchRun({
        userText: input.userText,
        editedScore: input.editedScore,
        history: input.history,
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
        ...(input.targetRegion !== undefined ? { targetRegion: input.targetRegion } : {}),
      })
    } catch (e) {
      const reason: FallThroughReason =
        e instanceof ToolDispatchError ? 'classifier_schema_error' : 'classifier_threw'
      const errorMessage = e instanceof Error ? e.message : String(e)
      await recordTurnT(input, {
        requestId: input.requestId,
        sessionId: input.chatId,
        label: 'fall_through',
        handler: 'toolDispatch',
        model: null,
        latencyMs: Date.now() - t0,
        finalStatus: 'fell_through',
        error: `${reason}: ${errorMessage}`,
        beforeScore: input.editedScore,
      })
      return fallThrough(reason, Date.now() - t0, { errorMessage })
    }
    return runDispatchedHandler(decision, input, t0)
  }

  // Classifier (Haiku 4.5).
  let classification: Classification
  try {
    classification = await classify({
      userText: input.userText,
      editedScore: input.editedScore,
      history: input.history,
    })
  } catch (e) {
    const reason: FallThroughReason =
      e instanceof ClassifierSchemaError ? 'classifier_schema_error' : 'classifier_threw'
    const errorMessage = e instanceof Error ? e.message : String(e)
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'fall_through',
      handler: 'classifier',
      model: 'claude-haiku-4-5',
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      error: `${reason}: ${errorMessage}`,
      beforeScore: input.editedScore,
    })
    return fallThrough(reason, Date.now() - t0, { errorMessage })
  }

  // Second deadline guard, between classifier and handler dispatch.
  // The classifier just consumed some of the budget; if the remaining
  // time can't plausibly cover a handler call, bail.
  if (
    input.deadlineAt !== undefined &&
    isDeadlineApproaching(input.deadlineAt, HANDLER_ESTIMATED_MS)
  ) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: classification.kind as TaskKind,
      handler: 'deadline',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      confidence: classification.confidence,
      error: 'deadline_exceeded',
      beforeScore: input.editedScore,
    })
    return fallThrough('deadline_exceeded', Date.now() - t0, { classification })
  }

  // Low confidence → fall through to legacy Sonnet (preserves today's
  // behavior on vague prompts).
  if (classification.confidence < CONFIDENCE_FLOOR) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'fall_through',
      handler: 'classifier',
      model: 'claude-haiku-4-5',
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      confidence: classification.confidence,
      beforeScore: input.editedScore,
    })
    return fallThrough('low_confidence', Date.now() - t0, { classification })
  }

  // Dispatch. Only KNOWN fall-through errors degrade to null —
  // transient LLM errors and programming bugs propagate so the route
  // (and the operator) sees them rather than silently re-running the
  // LLM call against the same prompt (double spend).
  let outcome: OrchestratorRunOutcome
  try {
    outcome = await dispatch(classification, input)
  } catch (e) {
    if (e instanceof EditHandlerError || e instanceof EditIntraMeasureError) {
      await recordTurnT(input, {
        requestId: input.requestId,
        sessionId: input.chatId,
        label: classification.kind as TaskKind,
        handler: 'dispatch',
        model: null,
        latencyMs: Date.now() - t0,
        finalStatus: 'fell_through',
        confidence: classification.confidence,
        error: `handler_error: ${e.message}`,
        beforeScore: input.editedScore,
      })
      return fallThrough('handler_error', Date.now() - t0, {
        classification,
        errorMessage: e.message,
      })
    }
    // RateLimitedError, UpstreamError, ValidationError, or any other
    // unexpected throw — log and re-throw. Route translates these
    // into the appropriate status codes.
    const errMsg = e instanceof Error ? e.message : 'unknown'
    const errClass =
      e instanceof RateLimitedError
        ? 'rate_limited'
        : e instanceof UpstreamError
          ? 'upstream_error'
          : e instanceof OutputTruncatedError
            ? 'output_truncated'
            : e instanceof ProviderSchemaError
              ? 'provider_schema_error'
              : e instanceof ValidationError
                ? 'validation_failed'
                : 'unexpected'
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: classification.kind as TaskKind,
      handler: 'dispatch',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'error',
      confidence: classification.confidence,
      error: `${errClass}: ${errMsg}`,
      beforeScore: input.editedScore,
    })
    throw e
  }

  if (outcome === null) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: classification.kind as TaskKind,
      handler: 'dispatch',
      model: null,
      latencyMs: Date.now() - t0,
      finalStatus: 'fell_through',
      confidence: classification.confidence,
      beforeScore: input.editedScore,
    })
    return fallThrough('handler_returned_null', Date.now() - t0, { classification })
  }

  if ('fellThrough' in outcome) {
    return outcome
  }

  // converse: streaming outcome — log as ok and let the route own the
  // stream lifecycle. Token usage is recorded by the route on message-stop.
  if (isOrchestratorConverseStream(outcome)) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'converse' as TaskKind,
      handler: 'converse',
      model: outcome.model,
      latencyMs: Date.now() - t0,
      finalStatus: 'ok',
      confidence: classification.confidence,
      beforeScore: input.editedScore,
    })
    return outcome
  }

  // M25-PR-4: streaming sectional generation. Like converse, the route
  // owns the stream lifecycle + persists the final score on `done`. We
  // record the turn optimistically here (token usage isn't known until
  // the generator finishes; matches the converse convention).
  if (isOrchestratorScoreStream(outcome)) {
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: classification.kind as TaskKind,
      handler: classification.kind as TaskKind,
      model: outcome.model,
      latencyMs: Date.now() - t0,
      finalStatus: 'ok',
      confidence: classification.confidence,
      beforeScore: input.editedScore,
    })
    return outcome
  }

  if ('refused' in outcome) {
    const refusal: OrchestratorRefusal = { ...outcome, latencyMs: Date.now() - t0 }
    await recordTurnT(input, {
      requestId: input.requestId,
      sessionId: input.chatId,
      label: 'refuse',
      handler: 'refuse',
      model: null,
      latencyMs: refusal.latencyMs,
      finalStatus: 'refused',
      confidence: classification.confidence,
      beforeScore: input.editedScore,
    })
    return refusal
  }

  const result: OrchestratorResult = isResult(outcome)
    ? { ...outcome, latencyMs: Date.now() - t0 }
    : outcome
  const replacementBlocked = await maybeApplyReplacementGate(result, input)
  maybeAttachGhostProposal(result, input)
  await recordTurnT(input, {
    requestId: input.requestId,
    sessionId: input.chatId,
    label: classification.kind as TaskKind,
    handler: classification.kind as TaskKind,
    model: result.model,
    latencyMs: result.latencyMs,
    finalStatus: 'ok',
    confidence: classification.confidence,
    beforeScore: input.editedScore,
    afterScore: result.score,
    appliedOpsCount: result.appliedOps?.length,
    ...(result.composePatchDispatch !== undefined
      ? { composePatchDispatch: result.composePatchDispatch }
      : {}),
    replacementBlocked,
  })
  return result
}

export type {
  Classification,
  OrchestratorConverseStream,
  OrchestratorInput,
  OrchestratorResult,
  OrchestratorRefusal,
  OrchestratorRunOutcome,
  RefusalCode,
  TaskKind,
} from './types'
