/**
 * Per-request deadline plumbing.
 *
 * Vercel's route `maxDuration` is 60s. A local-Ollama chain
 * (classifier + handler + validation retry) can blow that budget on
 * consumer hardware. Each LLM-calling handler should consult
 * `remainingMs(deadlineAt)` and refuse to start a call that won't
 * plausibly finish, returning a `deadline_exceeded` fall-through
 * instead of letting Vercel hard-cut the response.
 */

const DEFAULT_DEADLINE_MS = 55_000

export function computeDeadlineAt(now: number = Date.now()): number {
  const env = process.env.DEADLINE_MS
  const parsed = env ? Number(env) : NaN
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEADLINE_MS
  return now + ms
}

export function remainingMs(deadlineAt: number, now: number = Date.now()): number {
  return Math.max(0, deadlineAt - now)
}

/**
 * True when starting a call now is likely to overrun the deadline.
 *
 * - With an estimated call cost: returns `estimatedCallMs > remaining`.
 * - Without an estimate: returns true if less than 1s remains
 *   (conservative — no reasonable LLM call completes in <1s).
 */
export function isDeadlineApproaching(
  deadlineAt: number,
  estimatedCallMs?: number,
  now: number = Date.now(),
): boolean {
  const rem = remainingMs(deadlineAt, now)
  if (estimatedCallMs === undefined) return rem < 1_000
  return estimatedCallMs > rem
}
