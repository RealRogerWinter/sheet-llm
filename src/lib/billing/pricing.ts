/**
 * Canonical token cost model — USD per 1M tokens.
 *
 * Single source of truth for BOTH eval cost estimates and customer
 * billing. `evals/lib/pricing.ts` re-exports from here.
 *
 * MONEY-UNIT CONTRACT: the cost functions return USD as a floating-point
 * number. That float is correct to compute with, but it must NOT be the
 * stored ledger unit. The credit ledger (PR-5) accumulates in INTEGER
 * micro-USD and rounds UP at the charge boundary, so rounding can never
 * fall in the customer's favor. Do not persist these floats directly.
 *
 * Anthropic cache multipliers: cache READ = 0.1x base input; cache WRITE
 * (5-min "ephemeral" TTL) = 1.25x base input. Only the 5-minute write TTL
 * is used by the orchestrator today. The 1-hour TTL (2x) is intentionally
 * NOT modeled here, so a 1-hour write can never silently bill at the wrong
 * rate — add its rate together with the billing wiring if 1-hour caching
 * is ever introduced.
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
}

export const PRICING: Record<string, ModelPricing> = {
  // Anthropic — current generation.
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1, cacheWrite5mPerM: 1.25 },
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1, cacheWrite5mPerM: 1.25 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3, cacheWrite5mPerM: 3.75 },
  // Opus 4.5+ was re-priced 3x lower than 4.1; 4.7 and 4.8 share the $5/$25 tier.
  // (Opus 4.1 and earlier remain at the old $15/$75 tier and are intentionally absent.)
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25 },
  'claude-opus-4-7-20251201': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25 },
  'claude-opus-4-8-20260528': { inputPerM: 5, outputPerM: 25, cachedInputPerM: 0.5, cacheWrite5mPerM: 6.25 },

  // Groq (SHE-15 cheaper-model experiment). Verified groq.com/pricing 2026-06-09.
  // Groq levies no cache-WRITE premium, so cacheWrite5mPerM == inputPerM; and
  // cachedInputPerM is the published Groq cached rate where available, else
  // == inputPerM (conservative — no phantom discount). Inert for production
  // billing: production routes Anthropic only (production never selects Groq).
  'llama-3.1-8b-instant': { inputPerM: 0.05, outputPerM: 0.08, cachedInputPerM: 0.05, cacheWrite5mPerM: 0.05 },
  'openai/gpt-oss-20b': { inputPerM: 0.075, outputPerM: 0.3, cachedInputPerM: 0.0375, cacheWrite5mPerM: 0.075 },
  'openai/gpt-oss-120b': { inputPerM: 0.15, outputPerM: 0.6, cachedInputPerM: 0.075, cacheWrite5mPerM: 0.15 },
  'qwen/qwen3-32b': { inputPerM: 0.29, outputPerM: 0.59, cachedInputPerM: 0.29, cacheWrite5mPerM: 0.29 },
  'llama-3.3-70b-versatile': { inputPerM: 0.59, outputPerM: 0.79, cachedInputPerM: 0.59, cacheWrite5mPerM: 0.59 },
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

/** Thrown by the strict billing path on a non-integer or negative token count. */
export class InvalidUsageError extends Error {
  readonly field: string
  readonly value: number
  constructor(field: string, value: number) {
    super(`Invalid token count for "${field}": ${value} — expected a non-negative integer`)
    this.name = 'InvalidUsageError'
    this.field = field
    this.value = value
  }
}

/**
 * Disjoint per-call token usage, mirroring the Anthropic `usage` object.
 * The four buckets do NOT overlap — together they are the whole call.
 *
 * Every field is REQUIRED on purpose. The cache buckets must be sourced
 * explicitly from `usage.cache_read_input_tokens` /
 * `usage.cache_creation_input_tokens`, so a caller can never *silently*
 * drop the (more expensive) cache-write bucket and under-bill. Pass `0`
 * deliberately when a bucket is empty. PR-2 (provider-boundary metering)
 * plumbs `cache_creation_input_tokens` through the provider and populates
 * these — and because the field is required, that PR cannot compile
 * without providing it.
 */
export interface BillableUsage {
  /** `usage.input_tokens` — uncached, non-cache-creation input. */
  uncachedInputTokens: number
  /** `usage.output_tokens`. */
  outputTokens: number
  /** `usage.cache_read_input_tokens` — billed at 0.1x. */
  cacheReadInputTokens: number
  /** `usage.cache_creation_input_tokens` — billed at 1.25x (5-min TTL). */
  cacheCreationInputTokens: number
}

/** `Number.isInteger` rejects NaN, ±Infinity, and fractional values at once. */
function assertCount(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidUsageError(field, value)
  }
}

/**
 * STRICT, billing-grade cost in USD for one provider call. Fails CLOSED:
 *   - THROWS {@link UnknownModelPricingError} on an unpriced model — a
 *     customer debit must never silently fall back to $0.
 *   - THROWS {@link InvalidUsageError} on any non-integer / negative token
 *     count — a NaN/negative/Infinity must never flow into a debit.
 *
 * Returns USD as a float; the caller converts to integer micro-USD for the
 * ledger (see the money-unit contract at the top of this file). Use this —
 * NOT {@link estimateCostUsd} — for anything that touches a customer balance.
 */
export function billableCostUsd(model: string, usage: BillableUsage): number {
  const p = PRICING[model]
  if (!p) throw new UnknownModelPricingError(model)
  assertCount('uncachedInputTokens', usage.uncachedInputTokens)
  assertCount('outputTokens', usage.outputTokens)
  assertCount('cacheReadInputTokens', usage.cacheReadInputTokens)
  assertCount('cacheCreationInputTokens', usage.cacheCreationInputTokens)
  return (
    usage.uncachedInputTokens * p.inputPerM +
    usage.cacheReadInputTokens * p.cachedInputPerM +
    usage.cacheCreationInputTokens * p.cacheWrite5mPerM +
    usage.outputTokens * p.outputPerM
  ) / 1_000_000
}

/**
 * LENIENT cost estimate for evals / telemetry ONLY — never for customer
 * billing (use {@link billableCostUsd} for money). Unknown model → 0 with a
 * one-line stderr warning; non-finite / negative inputs are coerced to 0 so
 * an eval can never crash or block on noisy telemetry.
 *
 * `inputTokens` is the TOTAL prompt input; the cached + cache-creation
 * subsets are passed separately and subtracted out so each is billed at its
 * own rate. Signature-compatible with the original eval helper.
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
  const total = nonNeg(inputTokens)
  const cached = nonNeg(cachedInputTokens)
  const created = nonNeg(cacheCreationTokens)
  const output = nonNeg(outputTokens)
  const uncached = Math.max(0, total - cached - created)
  return (
    uncached * p.inputPerM +
    cached * p.cachedInputPerM +
    created * p.cacheWrite5mPerM +
    output * p.outputPerM
  ) / 1_000_000
}

/** Coerce a possibly non-finite / negative telemetry number to a safe value >= 0. */
function nonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0
}
