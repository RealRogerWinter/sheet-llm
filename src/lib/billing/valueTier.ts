import { billableCostUsd } from './pricing'
import type { TaskKind } from '@/lib/orchestrator/types'

/**
 * VALUE-TIER PRICING — turns our RAW metered Anthropic cost into a customer
 * CREDIT charge, and sizes the pre-dispatch hold.
 *
 * The charge is COST-PLUS on the metered cost (locked interview decision
 * 2026-06-04), NOT a flat tier:
 *   credits = ceil(cost_micro_usd × markup / MICRO_USD_PER_CREDIT)
 * with a 2.5× markup on generations and a gentler 1.2× on deterministic /
 * single edits (so iterative refinement isn't punished). With 1 credit = 1¢
 * this reproduces the locked anchors exactly: a ~$0.09 warm generation → 23
 * credits, a ~$0.30 Opus turn → 75 credits.
 *
 * The {@link VALUE_TIERS} numbers (edit 5 / standard 25 / full 60 / opus 150)
 * are DISPLAY / QUOTE anchors and the fail-closed FALLBACK charge when the
 * metered cost is unreadable on a delivered turn — they are NOT the charge on
 * the happy path. Rounding is always UP (never in the customer's favour); see
 * the money-unit contract in `pricing.ts`.
 *
 * DARK: the paywall in `/api/chat` (PR-7b) is the only caller, behind
 * `SL_PAID_GENERATION`.
 */

/** 1 credit = 1 cent of customer value = 10_000 micro-USD. */
export const MICRO_USD_PER_CREDIT = 10_000

/** Cost-plus markup on a GENERATION's raw metered cost (locked: 2.5×). */
export const MARKUP_GENERATE = 2.5
/** Gentler markup on a deterministic / single EDIT (user 2026-06-04: 1.2×). */
export const MARKUP_EDIT = 1.2

/**
 * Display / quote anchors AND the fail-closed fallback charge (credits) when a
 * delivered turn's metered cost is unreadable. NOT the happy-path charge.
 */
export const VALUE_TIERS = { edit: 5, standard: 25, full: 60, opus: 150 } as const
export type ValueTier = keyof typeof VALUE_TIERS

/** Is this a deterministic / single EDIT (1.2× markup) vs a generation (2.5×)? */
function isEditKind(kind: TaskKind): boolean {
  return kind === 'edit_score_level' || kind === 'edit_intra_measure'
}

/** The cost-plus markup for a finished turn, by its classification kind. */
export function markupForKind(kind: TaskKind): number {
  return isEditKind(kind) ? MARKUP_EDIT : MARKUP_GENERATE
}

/**
 * The fail-closed FALLBACK charge (credits) for a DELIVERED turn whose metered
 * cost is unreadable (NULL / 0-with-output / a recordTurn DB miss). Edits get
 * the small edit anchor; generations get the standard anchor. NULL ≠ free.
 */
export function fallbackCreditsForKind(kind: TaskKind): number {
  return isEditKind(kind) ? VALUE_TIERS.edit : VALUE_TIERS.standard
}

/**
 * Cost-plus charge in integer credits for `microUsd` of raw cost at `markup`,
 * rounded UP, with a 1-credit floor on any non-zero metered turn. Returns 0
 * for a non-positive / non-finite cost so the caller can detect "no metered
 * cost" and apply the fail-closed fallback ({@link fallbackCreditsForKind}).
 */
export function costToCredits(microUsd: number, markup: number): number {
  if (!Number.isFinite(microUsd) || microUsd <= 0) return 0
  return Math.max(1, Math.ceil((microUsd * markup) / MICRO_USD_PER_CREDIT))
}

// ── Worst-case hold sizing ────────────────────────────────────────────────
// A PROVABLE upper bound on what a Pro NON-STREAMING turn can settle to, so a
// hold sized to it guarantees creditsCharged ≤ hold and `settleHold`'s overHold
// flag is a paging-alert backstop, never the business model. Bounds (not
// estimates), at the priciest in-scope model — Sonnet 4.6; Advanced/Opus
// routing is PR-8 — all input billed UNCACHED (the most expensive case; real
// turns pay the cheaper cache-read rate):
//   handler: up to MAX_HANDLER_ATTEMPTS attempts, each `maxOutputTokens` out +
//            WORST_INPUT_TOKENS_PER_CALL in
//   overhead: classifier (Haiku) + planner + dispatcher, folded into one
//            generous Sonnet-priced bound
// Sonnet 4.6 is the priciest IN-SCOPE model. PR-8 adds Advanced/Opus routing —
// re-derive WORST_MODEL when that lands (Opus computes to a larger hold), else an
// Opus turn would routinely trip overHold.
const WORST_MODEL = 'claude-sonnet-4-6'
/** completeWithRetry default maxRetries = 2 ⇒ 1 initial + 2 retries. */
const MAX_HANDLER_ATTEMPTS = 3
// Generous per-call input bound: render_score schema (~13k) + a large grand-staff
// score (~15k) + recent history, all billed UNCACHED. Covers realistic large
// editedScores without false overHold alerts. The absolute MAX_BODY_BYTES (1MB)
// pathological input is intentionally backstopped by settleHold's overHold cap
// (we never overdraft; the alert fires) rather than inflating every hold —
// deliberately attacking it costs the (paid) attacker far more than it costs us.
const WORST_INPUT_TOKENS_PER_CALL = 80_000
const OVERHEAD_INPUT_TOKENS = 20_000
const OVERHEAD_OUTPUT_TOKENS = 2_000

/**
 * Provable worst-case hold (credits) for a Pro non-streaming turn whose handler
 * emits at most `maxOutputTokens`. Never below {@link VALUE_TIERS}.standard so a
 * trivial turn still reserves a sane minimum.
 */
export function worstCaseHoldCredits(maxOutputTokens: number): number {
  const handlerUsd =
    MAX_HANDLER_ATTEMPTS *
    billableCostUsd(WORST_MODEL, {
      uncachedInputTokens: WORST_INPUT_TOKENS_PER_CALL,
      outputTokens: maxOutputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  const overheadUsd = billableCostUsd(WORST_MODEL, {
    uncachedInputTokens: OVERHEAD_INPUT_TOKENS,
    outputTokens: OVERHEAD_OUTPUT_TOKENS,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  })
  const microUsd = Math.ceil((handlerUsd + overheadUsd) * 1_000_000)
  return Math.max(VALUE_TIERS.standard, costToCredits(microUsd, MARKUP_GENERATE))
}
