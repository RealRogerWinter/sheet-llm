/**
 * Token pricing table — USD per 1M tokens. Update as Anthropic
 * publishes new prices. Live-tier `LiveCaseResult` uses these for
 * per-case cost estimates surfaced in CI logs.
 *
 * Sources: https://www.anthropic.com/pricing (verify before committing
 * a bump). Cached input tokens are billed at 0.1x input rate.
 *
 * Verified 2026-05-25. Update via PR when Anthropic ships new tiers.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerM: number
  /** USD per 1M output tokens. */
  outputPerM: number
  /** USD per 1M cached-input tokens (~0.1x of input). */
  cachedInputPerM: number
}

export const PRICING: Record<string, ModelPricing> = {
  // Anthropic — current generation
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1 },
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 },
  // Opus 4.7 was re-priced 3x lower starting with Opus 4.5/4.6.
  // Opus 4.1 and earlier remain at the old $15/$75 tier.
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5 },
  'claude-opus-4-7-20251201': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5 },
}

/**
 * Compute USD cost for one call. `inputTokens` is the total prompt
 * (including any cached portion). `cachedInputTokens` is the cached
 * subset — billed at the lower cached rate. Unknown models return 0
 * with a one-line warning to stderr; the result is logged but never
 * blocks a test.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  const entry = PRICING[model]
  if (!entry) {
    if (process.env.EVAL_SILENT !== '1') {
      console.warn(`[eval pricing] unknown model "${model}" — cost recorded as 0`)
    }
    return 0
  }
  const nonCachedInput = Math.max(0, inputTokens - cachedInputTokens)
  return (
    (nonCachedInput * entry.inputPerM) / 1_000_000 +
    (cachedInputTokens * entry.cachedInputPerM) / 1_000_000 +
    (outputTokens * entry.outputPerM) / 1_000_000
  )
}
