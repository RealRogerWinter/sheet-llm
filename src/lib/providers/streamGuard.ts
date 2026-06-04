/**
 * Reusable per-request output kill-switch for STREAMING provider calls (M26
 * PR-2). Pure and dependency-free so it's trivially unit-testable. A streaming
 * call (currently `AnthropicProvider.textStream`) calls `shouldAbort` with the
 * accumulated character count after each chunk; a `true` return means the call
 * should be aborted now.
 *
 * Two independent triggers:
 *  - output-token budget — estimated as `accumulatedChars / charsPerToken`,
 *    deliberately an OVER-count (default 3.5 chars/token) so the guard aborts
 *    slightly EARLY and can never be bypassed by an under-estimate.
 *  - wall-clock deadline — an absolute epoch-ms timestamp.
 *
 * Distinct from `max_tokens` (the provider-enforced HARD per-response ceiling
 * the model is unaware of): this is the SECONDARY layer that also bounds
 * WALL-CLOCK time and works on streamed text where `max_tokens` alone can't cut
 * a slow stream short.
 */
export interface OutputBudgetGuardOpts {
  /** Abort once estimated output tokens reach this. Omit to disable. */
  outputTokenBudget?: number
  /** Absolute epoch-ms deadline (Date.now()); abort when reached. Omit to disable. */
  deadlineAt?: number
  /** Chars-per-token estimate (conservative over-count). Default 3.5. */
  charsPerToken?: number
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

export type OutputBudgetGuardReason = '' | 'output_budget_exceeded' | 'deadline_exceeded'

export interface OutputBudgetGuard {
  /** Returns true the first instant the request should be aborted. */
  shouldAbort(accumulatedChars: number): boolean
  /** Why the guard tripped ('' until it has). */
  reason: OutputBudgetGuardReason
}

export function makeOutputBudgetGuard(opts: OutputBudgetGuardOpts): OutputBudgetGuard {
  const charsPerToken = opts.charsPerToken ?? 3.5
  const now = opts.now ?? Date.now
  const guard: OutputBudgetGuard = {
    reason: '',
    shouldAbort(accumulatedChars: number): boolean {
      // Deadline takes precedence — a stuck-but-not-yet-overlong stream is the
      // case max_tokens can't catch.
      if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) {
        guard.reason = 'deadline_exceeded'
        return true
      }
      if (
        opts.outputTokenBudget !== undefined &&
        accumulatedChars / charsPerToken >= opts.outputTokenBudget
      ) {
        guard.reason = 'output_budget_exceeded'
        return true
      }
      return false
    },
  }
  return guard
}
