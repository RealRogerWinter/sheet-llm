import type { Score } from '@/lib/music/types'
import type { ChatMessage } from '@/lib/llm/wrapper'
import { run as runOrchestrator } from '@/lib/orchestrator'
import type { OrchestratorRunOutcome } from '@/lib/orchestrator'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'
import { RateLimitedError, UpstreamError } from '@/lib/llm/errors'
import { estimateCostUsd } from './pricing'

/**
 * Live-tier eval runner. Hits the REAL Anthropic provider via the
 * orchestrator. Gated by env vars at the case-file level (see
 * `evals/cases/*.live.eval.ts` — each file uses `describe.skipIf(!RUN_LIVE)`).
 *
 * Retries on `UpstreamError` / `RateLimitedError` with exponential
 * backoff. Distinguishes infra failure (returned `kind: 'infra'`) from
 * eval failure (returned `kind: 'ok'` with `result`) so the per-file
 * assertion phase can fail-or-skip distinctly. CI can then read these
 * exit codes:
 *   0  — all cases passed
 *   1  — at least one assertion failed (real bug)
 *   78 — infra-only failures (treat as retryable, not a regression)
 *
 * Per-case cache-hit-rate warning: cached_input_tokens / input_tokens
 * < 0.8 emits a stderr line but never fails the test. The 5-minute
 * Anthropic cache TTL means legitimate prompt edits can drop this
 * temporarily; a hard assertion would flake. Aggregate at end-of-run
 * to summarize the fleet (see `summarizeLiveResults` below).
 */

export interface LiveCaseInput {
  /** Stable case id; used for log lines and `requestId` prefix. */
  id: string
  /** The user prompt to send to the orchestrator. */
  userText: string
  /** Optional starting Score in session — drives compose vs generate. */
  initialScore?: Score
  /** Pre-existing conversation history (usually empty for cases). */
  history?: ReadonlyArray<ChatMessage>
  /** Force a specific Anthropic model id (e.g. for smoke tests on Haiku). */
  modelOverride?: string
}

export interface LiveCaseOptions {
  /** Max attempts on UpstreamError / RateLimitedError. Default 3. */
  maxAttempts?: number
  /** Base backoff ms (doubles per attempt). Default 250. */
  backoffBaseMs?: number
  /** Threshold below which a cache-hit warning fires. Default 0.8. */
  cacheHitWarnThreshold?: number
}

export type LiveCaseResultKind = 'ok' | 'infra'

export interface LiveCaseResult {
  caseId: string
  kind: LiveCaseResultKind
  /** Orchestrator outcome on success. Undefined on infra failure. */
  outcome?: OrchestratorRunOutcome
  /** Number of attempts taken (1 = first try). */
  attempts: number
  /** Wall-clock latency from runner entry to outcome. */
  latencyMs: number
  /** Last infra error encountered (defined when kind === 'infra'). */
  lastError?: { name: string; message: string }
  /** Effective model id of the producing call (best-effort). */
  model?: string
  /** Total input + output token estimate from the outcome's usage. */
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  /** Cached / input ratio. Null when input is 0 or absent. */
  cacheHitRatio: number | null
  /** USD cost estimate via `evals/lib/pricing.ts`. */
  estimatedCostUsd: number
}

/** Sleep helper that we don't bother polyfilling. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Skip the live tier when a commit message contains the bypass token.
 * Wire this into the CI driver (PR-5/PR-6) — not into vitest, because
 * vitest exit codes drive CI gating and we don't want bypass cases to
 * be silently re-runnable.
 */
export const SKIP_LIVE_EVAL_TOKEN = '[skip-live-eval]'

export async function isSkippedByCommitMessage(): Promise<boolean> {
  // Optional, best-effort. The check shells out to git; on failure we
  // fall through to "not skipped" so an accidental fork repo doesn't
  // accidentally skip its own live evals.
  try {
    const { execSync } = await import('node:child_process')
    const msg = execSync('git log -1 --pretty=%B', { encoding: 'utf8' })
    return msg.includes(SKIP_LIVE_EVAL_TOKEN)
  } catch {
    return false
  }
}

/**
 * Run one live eval case against the real orchestrator. Caller asserts
 * invariants on `result.outcome` separately — runner only owns
 * dispatch, retry, telemetry.
 */
export async function runLiveCase(
  input: LiveCaseInput,
  options: LiveCaseOptions = {},
): Promise<LiveCaseResult> {
  const maxAttempts = options.maxAttempts ?? 3
  const backoffBaseMs = options.backoffBaseMs ?? 250
  const cacheHitWarnThreshold = options.cacheHitWarnThreshold ?? 0.8

  const requestId = `eval_live_${input.id}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
  const t0 = Date.now()
  let lastError: { name: string; message: string } | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const outcome = await runOrchestrator({
        requestId,
        chatId: `eval-live-${input.id}`,
        userText: input.userText,
        ...(input.initialScore !== undefined ? { editedScore: input.initialScore } : {}),
        history: input.history ?? [],
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        // SHE-8: preserve the pre-inversion default (absent tier ⇒ 'free') now
        // that the orchestrator reads an injected policy, not generationTier.
        tierPolicy: toTierPolicy('free'),
      })

      const tel = extractTelemetry(outcome)
      const cacheHitRatio =
        tel.inputTokens && tel.inputTokens > 0
          ? (tel.cachedInputTokens ?? 0) / tel.inputTokens
          : null

      if (
        cacheHitRatio !== null &&
        cacheHitRatio < cacheHitWarnThreshold &&
        process.env.EVAL_SILENT !== '1'
      ) {
        console.warn(
          `[eval cache warning] case="${input.id}" cache-hit-ratio=${cacheHitRatio.toFixed(2)} < ${cacheHitWarnThreshold} (input=${tel.inputTokens} cached=${tel.cachedInputTokens ?? 0}) — investigate prompt-cache invalidation`,
        )
      }

      const estimatedCostUsd = tel.model
        ? estimateCostUsd(
            tel.model,
            tel.inputTokens ?? 0,
            tel.outputTokens ?? 0,
            tel.cachedInputTokens ?? 0,
          )
        : 0

      return {
        caseId: input.id,
        kind: 'ok',
        outcome,
        attempts: attempt,
        latencyMs: Date.now() - t0,
        ...(tel.model !== undefined ? { model: tel.model } : {}),
        ...(tel.inputTokens !== undefined ? { inputTokens: tel.inputTokens } : {}),
        ...(tel.outputTokens !== undefined ? { outputTokens: tel.outputTokens } : {}),
        ...(tel.cachedInputTokens !== undefined
          ? { cachedInputTokens: tel.cachedInputTokens }
          : {}),
        cacheHitRatio,
        estimatedCostUsd,
      }
    } catch (e) {
      if (e instanceof UpstreamError || e instanceof RateLimitedError) {
        lastError = { name: e.constructor.name, message: e.message }
        if (attempt < maxAttempts) {
          const delay = backoffBaseMs * 2 ** (attempt - 1)
          if (process.env.EVAL_SILENT !== '1') {
            console.warn(
              `[eval infra retry] case="${input.id}" attempt=${attempt}/${maxAttempts} ${lastError.name}: ${lastError.message.slice(0, 100)} — backoff ${delay}ms`,
            )
          }
          await sleep(delay)
          continue
        }
      }
      // Non-infra throws bubble up. The vitest test sees the throw and
      // fails with the original stack, which is what we want for
      // programming-bug detection (vs. retry-blindness).
      if (!(e instanceof UpstreamError) && !(e instanceof RateLimitedError)) {
        throw e
      }
    }
  }

  return {
    caseId: input.id,
    kind: 'infra',
    attempts: maxAttempts,
    latencyMs: Date.now() - t0,
    ...(lastError !== undefined ? { lastError } : {}),
    cacheHitRatio: null,
    estimatedCostUsd: 0,
  }
}

/**
 * Best-effort extraction of usage telemetry from the orchestrator's
 * outcome union. Different outcome shapes carry different fields;
 * we read what's there and shrug at the rest. The runner is
 * informational — a missing field means "we didn't get that signal
 * from this turn", not "the harness is broken".
 */
function extractTelemetry(outcome: OrchestratorRunOutcome): {
  model?: string
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
} {
  if (!outcome || typeof outcome !== 'object') return {}
  const out: {
    model?: string
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
  } = {}
  if ('model' in outcome && typeof outcome.model === 'string') {
    out.model = outcome.model
  }
  // OrchestratorResult and OrchestratorConverseStream may carry a
  // `usage` field populated by the handler. Read it permissively
  // (different outcome shapes don't all carry usage today; missing
  // fields mean "we didn't get that signal", not "the harness is
  // broken").
  if ('usage' in outcome && outcome.usage && typeof outcome.usage === 'object') {
    const u = outcome.usage as {
      inputTokens?: unknown
      outputTokens?: unknown
      cachedInputTokens?: unknown
    }
    if (typeof u.inputTokens === 'number') out.inputTokens = u.inputTokens
    if (typeof u.outputTokens === 'number') out.outputTokens = u.outputTokens
    if (typeof u.cachedInputTokens === 'number') out.cachedInputTokens = u.cachedInputTokens
  }
  return out
}

/**
 * Aggregate per-case results and write a one-line CI summary to
 * stderr. Call this from an `afterAll` block at the end of a live
 * eval suite. Non-fatal — never throws.
 */
export function summarizeLiveResults(results: ReadonlyArray<LiveCaseResult>): {
  total: number
  infra: number
  lowCacheHit: number
  totalCostUsd: number
} {
  const total = results.length
  const infra = results.filter((r) => r.kind === 'infra').length
  const lowCacheHit = results.filter(
    (r) => r.cacheHitRatio !== null && r.cacheHitRatio < 0.8,
  ).length
  const totalCostUsd = results.reduce((sum, r) => sum + r.estimatedCostUsd, 0)
  if (process.env.EVAL_SILENT !== '1') {
    console.warn(
      `[eval live summary] cases=${total} infra-fails=${infra} low-cache-hit=${lowCacheHit}/${total} cost=$${totalCostUsd.toFixed(4)}`,
    )
  }
  return { total, infra, lowCacheHit, totalCostUsd }
}
