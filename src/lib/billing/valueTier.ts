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
// Non-streaming per-call input bound: render_score schema (~13k) + a large
// grand-staff score (~15k) + recent history, all billed UNCACHED. Covers
// realistic large editedScores without false overHold alerts.
const WORST_INPUT_TOKENS_PER_CALL = 80_000
const OVERHEAD_INPUT_TOKENS = 20_000
const OVERHEAD_OUTPUT_TOKENS = 2_000

// Sectional (streaming) worst case — the PRICIEST outcome a request can resolve
// to (generate_complex → runGenerateSectionalStream chains many bounded
// sub-calls within maxDuration; PR-7b-2 settles it). The pre-dispatch hold is
// placed BEFORE the outcome is known, so it must cover this. Sized so a
// legitimate cold sectional settles UNDER the hold (overHold stays a rare
// anomaly alert, not the business model) AND the hold stays at/below the $5 min
// pack (500 cr) so a min-pack buyer can start a generation. Per-section input is
// the steady-state delta — the schema/score prefix is cache-read across sections
// in prod — but billed uncached here for headroom.
const MAX_SECTIONS = 12 // measured worst sectional ≈ 10–12 chained calls
const SECTION_INPUT_TOKENS = 12_000

/**
 * Provable worst-case hold (credits) for a Pro turn — the MAX over the possible
 * outcomes (a non-streaming handler at `maxOutputTokens` × up-to-3 attempts, vs a
 * full sectional generation), since the hold is placed before the outcome is
 * known. So `creditsCharged ≤ hold` for any path and settleHold's overHold flag
 * is a rare paging-alert backstop, never the model. Never below
 * {@link VALUE_TIERS}.standard.
 *
 * NOTE (LAUNCH GATE — PR-7b-2c): this fixed pre-run hold does NOT fully cover a
 * LARGE sectional, whose per-call input GROWS (the full score is re-sent each
 * section) with no call cap (only maxDuration). Such a piece can settle ABOVE the
 * hold → settleHold caps the debit (overHold; never overdrafts) and we UNDER-EARN;
 * and if it runs past maxDuration before `done` it is killed → the hold is reaped
 * → free (we eat the raw cost). These are LAUNCH GATES, not at-merge issues (the
 * flag is dark): the operator must enable the streaming wall-clock abort so a long
 * stream ends cleanly at `done` (→ settle), AND per-section debiting +
 * abort-before-overspend (red-team #3) must land — tracked as PR-7b-2c. Do NOT
 * flip SL_PAID_GENERATION until both are in place.
 */
export function worstCaseHoldCredits(maxOutputTokens: number): number {
  const nonStreamingUsd =
    MAX_HANDLER_ATTEMPTS *
    billableCostUsd(WORST_MODEL, {
      uncachedInputTokens: WORST_INPUT_TOKENS_PER_CALL,
      outputTokens: maxOutputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  const sectionalUsd =
    MAX_SECTIONS *
    billableCostUsd(WORST_MODEL, {
      uncachedInputTokens: SECTION_INPUT_TOKENS,
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
  const microUsd = Math.ceil((Math.max(nonStreamingUsd, sectionalUsd) + overheadUsd) * 1_000_000)
  return Math.max(VALUE_TIERS.standard, costToCredits(microUsd, MARKUP_GENERATE))
}
