/**
 * Canonical token cost model — USD per 1M tokens.
 *
 * Single source of truth for BOTH eval cost estimates and customer
 * billing. `evals/lib/pricing.ts` re-exports from here, so there is one
 * place to update when Anthropic ships new prices.
 *
 * Anthropic cache multipliers (uniform across models):
 *   - cache READ (hit)      = 0.1x  base input
 *   - cache WRITE, 5-min TTL = 1.25x base input
 *   - cache WRITE, 1-hr TTL  = 2x    base input
 *
 * Two cost paths, with deliberately different failure modes:
 *   - {@link billableCostUsd} — STRICT, for customer debits. Throws on an
 *     unpriced model so a debit can never silently fall back to $0.
 *   - {@link estimateCostUsd} — LENIENT, for evals/telemetry. Unknown
 *     model → 0 + a one-line warning; never blocks a test.
 *
 * Sources: https://www.anthropic.com/pricing — verify before a bump.
 * Verified 2026-06-04.
 */

export interface ModelPricing {
  /** USD per 1M uncached input tokens. */
  inputPerM: number
  /** USD per 1M output tokens. */
  outputPerM: number
  /** USD per 1M cache-READ (hit) input tokens (= 0.1x input). */
  cachedInputPerM: number
  /** USD per 1M cache-WRITE input tokens, 5-min TTL (= 1.25x input). */
  cacheWrite5mPerM: number
  /** USD per 1M cache-WRITE input tokens, 1-hr TTL (= 2x input). */
  cacheWrite1hPerM: number
}

export const PRICING: Record<string, ModelPricing> = {
  // Anthropic — current generation.
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1, cacheWrite5mPerM: 1.25, cacheWrite1hPerM: 2 },
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1, cacheWrite5mPerM: 1.25, cacheWrite1hPerM: 2 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3, cacheWrite5mPerM: 3.75, cacheWrite1hPerM: 6 },
  // Opus 4.5+ was re-priced 3x lower than 4.1; 4.7 and 4.8 share the $5/$25 tier.
  // (Opus 4.1 and earlier remain at the old $15/$75 tier and are intentionally absent.)
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
  'claude-opus-4-7-20251201': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
  'claude-opus-4-8-20260528': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
}

/** Thrown by the strict billing path on an unpriced model. */
export class UnknownModelPricingError extends Error {
  readonly model: string
  constructor(model: string) {
    super(`No pricing entry for model "${model}" — refusing to bill an unpriced call`)
    this.name = 'UnknownModelPricingError'
    this.model = model
  }
}

/**
 * Disjoint per-call token usage, mirroring the Anthropic `usage` object.
 * The three input buckets do NOT overlap — together they are the whole
 * prompt. This is the shape PR-2 metering will hand to the billing path.
 */
export interface BillableUsage {
  /** `usage.input_tokens` — uncached, non-cache-creation input. */
  uncachedInputTokens: number
  /** `usage.output_tokens`. */
  outputTokens: number
  /** `usage.cache_read_input_tokens` — billed at 0.1x. */
  cacheReadInputTokens?: number
  /** `usage.cache_creation_input_tokens` — billed at 1.25x (5-min TTL). */
  cacheCreationInputTokens?: number
}

/**
 * STRICT, billing-grade cost in USD for one provider call. THROWS
 * ({@link UnknownModelPricingError}) on an unpriced model — a customer
 * debit must never silently fall back to $0. Cache-creation (write)
 * tokens are billed at the 5-minute write multiplier (the only TTL the
 * orchestrator currently uses).
 */
export function billableCostUsd(model: string, usage: BillableUsage): number {
  const p = PRICING[model]
  if (!p) throw new UnknownModelPricingError(model)
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheCreationInputTokens ?? 0
  return (
    usage.uncachedInputTokens * p.inputPerM +
    cacheRead * p.cachedInputPerM +
    cacheWrite * p.cacheWrite5mPerM +
    usage.outputTokens * p.outputPerM
  ) / 1_000_000
}

/**
 * LENIENT cost estimate for evals / telemetry. Unknown model → 0 with a
 * one-line stderr warning (never blocks a test). `inputTokens` is the
 * TOTAL prompt input; the cached + cache-creation subsets are passed
 * separately and subtracted out so each is billed at its own rate.
 *
 * Signature-compatible with the original eval helper; the trailing
 * `cacheCreationTokens` arg is new and defaults to 0.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheCreationTokens = 0,
): number {
  const p = PRICING[model]
  if (!p) {
    if (process.env.EVAL_SILENT !== '1') {
      console.warn(`[eval pricing] unknown model "${model}" — cost recorded as 0`)
    }
    return 0
  }
  const uncached = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens)
  return (
    uncached * p.inputPerM +
    cachedInputTokens * p.cachedInputPerM +
    cacheCreationTokens * p.cacheWrite5mPerM +
    outputTokens * p.outputPerM
  ) / 1_000_000
}
