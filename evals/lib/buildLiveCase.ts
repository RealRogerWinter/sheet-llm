import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { appendFileSync } from 'node:fs'
import { computeKeyStatus } from '@/lib/orchestrator/keyStatus'
import type { Score } from '@/lib/music/types'
import type { OrchestratorResult, OrchestratorRunOutcome } from '@/lib/orchestrator/types'
import { runLiveCase, summarizeLiveResults, type LiveCaseResult } from './liveRunner'
import { assertScoreInvariants, type ScoreInvariants } from './assertions'
import {
  loadBaselines,
  recordLiveResult,
  detectRegression,
  type EvalCaseStatus,
} from './baselines'

/**
 * Live-case skeleton used by every `*.live.eval.ts` under `evals/cases/`.
 *
 * Why a helper:
 * - Each case file would otherwise repeat ~40 lines of skip-when-unset
 *   boilerplate, the `runLiveCase` invocation, the
 *   `assertScoreInvariants` plumbing, the per-model-SHA baseline
 *   bookkeeping, and the summary-emission afterAll. Hoist it once so
 *   the case files are 95% case-specific data.
 *
 * Gating:
 * - `RUN_LIVE_EVALS=1` AND `ANTHROPIC_API_KEY` set → cases execute.
 * - Anything else → cases skip via `describe.skipIf`. The reason
 *   string is logged for CI clarity.
 *
 * Per-case extras:
 * - `expensive: true` cases additionally require `RUN_LIVE_FULL=1`.
 *   Use this for multi-voice / long-context cases that shouldn't run
 *   on every nightly.
 * - `softAssertions: true` cases run the invariants but only log
 *   failures to stderr — never fail the test. Used for diagnostic
 *   cases like the lowercase-roman ambiguity probe where multiple
 *   model behaviors are defensible.
 */

/** A single live eval case definition. */
export interface LiveCaseSpec {
  /** Stable case id; doubles as request-id prefix. Use kebab-case. */
  id: string
  /** Human-readable title for vitest output. */
  title: string
  /** The starting score the orchestrator sees as `editedScore`. */
  initialScore: Score
  /** The user prompt sent to the orchestrator. */
  userText: string
  /** Invariant predicates evaluated against the applied score. */
  expected: ScoreInvariants
  /**
   * Optional extra per-case checks. Receives the orchestrator result
   * AND the runner's telemetry envelope so the case can assert on
   * `cadenceAtBoundary`, `dispatchTool`, `warnings`, etc.
   * Return an array of failure messages (empty = all-good).
   */
  extraAssertions?: (
    result: OrchestratorResult,
    runner: LiveCaseResult,
  ) => string[]
  /**
   * Gate this case behind `RUN_LIVE_FULL=1` in addition to
   * `RUN_LIVE_EVALS=1`. Used for expensive multi-voice or long-context
   * cases that shouldn't run on every nightly.
   */
  expensive?: boolean
  /**
   * Soft mode — invariant failures log to stderr instead of failing
   * the test. Diagnostic cases (lowercase-roman ambiguity) use this.
   */
  softAssertions?: boolean
  /** Optional history to pre-seed (rarely needed; default empty). */
  history?: never
}

/** Reason a live case skipped (logged once at suite registration). */
type SkipReason = 'no_run_flag' | 'no_api_key' | 'expensive_off' | null

export function skipReason(spec: LiveCaseSpec): SkipReason {
  if (process.env.RUN_LIVE_EVALS !== '1') return 'no_run_flag'
  // The dispatcher + handlers run on the MEDIUM tier; require THAT tier's
  // routed provider to be configured (Anthropic by default, or Groq when
  // PROVIDER_MEDIUM=groq + GROQ_API_KEY). Lets the SHE-15 matrix driver run a
  // Groq-only sweep without an Anthropic key, while the default Anthropic flow
  // stays gated on ANTHROPIC_API_KEY exactly as before.
  if (!computeKeyStatus().medium) return 'no_api_key'
  if (spec.expensive && process.env.RUN_LIVE_FULL !== '1') return 'expensive_off'
  return null
}

/** Format a per-case status row for the summary table. */
function fmtRow(spec: LiveCaseSpec, r: LiveCaseResult, status: string): string {
  const model = r.model ?? '-'
  const ti = r.inputTokens ?? 0
  const to = r.outputTokens ?? 0
  const tc = r.cachedInputTokens ?? 0
  const cost = r.estimatedCostUsd.toFixed(4)
  const cache =
    r.cacheHitRatio === null ? '   -' : (r.cacheHitRatio * 100).toFixed(0).padStart(3) + '%'
  return `${spec.id.padEnd(48)} | ${model.padEnd(28)} | ${String(ti).padStart(6)}/${String(to).padStart(5)}/${String(tc).padStart(6)} | $${cost} | ${cache} | ${status}`
}

/**
 * Register one live case with vitest. Spawns its own `describe` block
 * so cases stay reportable individually in the CI summary.
 */
export function buildLiveCase(spec: LiveCaseSpec): void {
  const reason = skipReason(spec)

  const cases: LiveCaseResult[] = []
  const statuses: string[] = []

  describe.skipIf(reason !== null)(`eval:live — ${spec.title}`, () => {
    let runner: LiveCaseResult
    let result: OrchestratorResult | null = null
    let invariantFailures: ReturnType<typeof assertScoreInvariants> = []
    let extraFailures: string[] = []
    let baselineStatus: EvalCaseStatus = 'new'
    // Live cases assert on `dispatchTool` / `cadenceAtBoundary` which
    // are only set when isNewToolDispatchEnabled() returns true. The
    // flag is OFF by default, so we force it on for the duration of
    // each case and restore the previous value afterwards.
    // (Defense in depth: the nightly workflow ALSO sets this env var
    // at the job level — but the flag flip is essential for local
    // `pnpm eval:live` runs where the workflow env doesn't apply.)
    let prevDispatchFlag: string | undefined

    beforeAll(async () => {
      prevDispatchFlag = process.env.SL_NEW_TOOL_DISPATCH
      process.env.SL_NEW_TOOL_DISPATCH = '1'
      runner = await runLiveCase({
        id: spec.id,
        userText: spec.userText,
        initialScore: spec.initialScore,
        // SHE-15 matrix driver pins one model across all tiers via this env.
        ...(process.env.SL_EVAL_MODEL_OVERRIDE
          ? { modelOverride: process.env.SL_EVAL_MODEL_OVERRIDE }
          : {}),
      })
      cases.push(runner)
    }, 120_000)

    it(spec.id, () => {
      if (runner.kind === 'infra') {
        statuses.push('INFRA')
        // Infra failure — do NOT fail the test. The summary line +
        // process exit code 78 (set by an outer driver) flags it.
        console.warn(
          `[eval live infra] case="${spec.id}" attempts=${runner.attempts} last="${runner.lastError?.message ?? '<none>'}"`,
        )
        return
      }

      const outcome = runner.outcome as OrchestratorRunOutcome
      if (
        !outcome ||
        typeof outcome !== 'object' ||
        !('score' in outcome) ||
        outcome.score === undefined
      ) {
        statuses.push('NO_SCORE')
        const msg = `case="${spec.id}" orchestrator returned a non-score outcome`
        if (spec.softAssertions) {
          console.warn(`[eval soft fail] ${msg}`)
          return
        }
        throw new Error(msg)
      }
      result = outcome as OrchestratorResult

      invariantFailures = assertScoreInvariants(
        {
          afterScore: result.score,
          appliedOps: result.appliedOps,
          requiresConfirmation: result.requiresConfirmation,
        },
        spec.expected,
        spec.initialScore,
      )

      extraFailures = spec.extraAssertions ? spec.extraAssertions(result, runner) : []

      const allFailures = [
        ...invariantFailures.map((f) => `${f.predicate}: ${f.message}`),
        ...extraFailures,
      ]

      // Baseline bookkeeping (only on real API model, not mocks).
      if (runner.model) {
        const baselines = loadBaselines()
        baselineStatus = detectRegression(baselines, runner.model, spec.id, allFailures.length === 0)
        recordLiveResult(baselines, runner.model, spec.id, {
          lastResult: allFailures.length === 0 ? 'pass' : 'fail',
          failures: allFailures,
        })
      }

      if (allFailures.length === 0) {
        statuses.push('PASS')
        return
      }

      const summary = allFailures.join('\n  ')
      if (spec.softAssertions) {
        statuses.push('SOFT_FAIL')
        console.warn(`[eval soft fail] case="${spec.id}"\n  ${summary}`)
        return
      }

      if (baselineStatus === 'regression') {
        statuses.push('REGRESSION')
        // Use a distinctive error message so an outer driver can
        // grep for it and exit 79 (regression) vs 1 (new failure).
        throw new Error(`[REGRESSION] ${spec.id}\n  ${summary}`)
      }
      statuses.push('FAIL')
      throw new Error(`${spec.id}\n  ${summary}`)
    })

    afterAll(() => {
      // Restore the dispatch flag we forced on in beforeAll.
      if (prevDispatchFlag === undefined) {
        delete process.env.SL_NEW_TOOL_DISPATCH
      } else {
        process.env.SL_NEW_TOOL_DISPATCH = prevDispatchFlag
      }
      // Per-case one-line summary so the CI log carries the table even
      // if vitest's reporter truncates failure detail. Suppressed when
      // EVAL_SILENT=1 or EVAL_SUMMARY_ONLY=1 (the latter suppresses
      // per-case detail and emits only the totals row at end-of-run
      // via summarizeLiveResults — typically wired by the nightly
      // workflow).
      if (
        cases.length > 0 &&
        process.env.EVAL_SILENT !== '1' &&
        process.env.EVAL_SUMMARY_ONLY !== '1'
      ) {
        const r = cases[cases.length - 1]
        const s = statuses[statuses.length - 1] ?? '?'
        console.warn(`[eval row] ${fmtRow(spec, r, s)}`)
      }

      // SHE-15: machine-readable per-case result sink for the model-matrix
      // driver. Independent of the console flags above; append one JSON line.
      const sink = process.env.SL_EVAL_RESULTS_FILE
      if (cases.length > 0 && sink) {
        const r = cases[cases.length - 1]
        const s = statuses[statuses.length - 1] ?? '?'
        try {
          appendFileSync(
            sink,
            JSON.stringify({
              caseId: spec.id,
              model: r.model ?? null,
              status: s,
              pass: s === 'PASS',
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cachedInputTokens: r.cachedInputTokens,
              estimatedCostUsd: r.estimatedCostUsd,
              latencyMs: r.latencyMs,
              attempts: r.attempts,
            }) + '\n',
          )
        } catch {
          // Never let telemetry I/O fail a case.
        }
      }
    })
  })

  if (reason !== null && process.env.EVAL_SILENT !== '1' && process.env.EVAL_DEBUG_SKIP === '1') {
    console.warn(`[eval skip] case="${spec.id}" reason=${reason}`)
  }
}

/**
 * Aggregate summary printer. Call at the end of a suite (or wire to
 * `--summary` flag) to print the totals row.
 *
 * Currently this is wired through `summarizeLiveResults` in
 * `liveRunner.ts`; this re-export is here so case files can pull
 * everything from one place.
 */
export { summarizeLiveResults }
