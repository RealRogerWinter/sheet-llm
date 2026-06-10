import type { Tier } from './types'

/**
 * THE model-class seam for tier routing (SHE-19).
 *
 * Maps a generation call's INTENT to the provider model-size `Tier` that
 * {@link import('./select').selectProvider} resolves to a concrete model.
 * This is the SINGLE tier-decision point for the whole codebase — the credit
 * hold in `billing/valueTier.ts` is sized to match the tier this returns, so
 * the two must be kept in sync.
 *
 * The ladder is BIASED TO THE CHEAPEST TIER and escalates:
 *
 *   1. `large` (Opus)   — ONLY for heavy compositional calls (`whole_score`,
 *      `extend`) when `advancedComposer === true` (a resolved paid entitlement).
 *   2. `medium` (Sonnet) — when `complexity === 'complex'` (classifier signal),
 *      regardless of call type (except when rule 1 already fires).
 *   3. `small` (Haiku)  — the default for everything else: classifiers,
 *      planners, dispatchers, conversational turns, and any call without an
 *      explicit complexity signal. Callers that have no complexity context
 *      (dispatcher, planner) simply omit the field and land here.
 *
 * SELECTIVE Opus routing (locked decision 6): only `whole_score` and `extend`
 * are eligible for the `large` tier — sectional loops, edits, and all
 * lightweight calls never reach Opus even with Advanced on.
 *
 * TRUST BOUNDARY: `advancedComposer` must already be the RESOLVED entitlement —
 * the chat route only sets it true for an authenticated, paid Pro generation
 * (never free tier, never the free piece) and behind `SL_ADVANCED_COMPOSER`.
 * This function does NOT re-check that; it is the caller's responsibility.
 * A free/anon turn never sets `advancedComposer`, so Opus stays unreachable
 * off the money path even though this function is product-flag-agnostic.
 */

/** The kind of LLM call a model class is being resolved for. */
export type ModelCallType =
  | 'whole_score' // single-shot whole-score emit (generateComplex / compose) — HEAVY
  | 'extend' // standalone extend-composition — HEAVY
  | 'section' // sectional seed/extend loop — never Opus (Sonnet-tuned)
  | 'edit' // intra-measure / region / insert edits
  | 'plan' // score planner
  | 'dispatch' // tool dispatcher
  | 'classify' // request classifier
  | 'converse' // read-only Q&A
  | 'bounded' // free-tier bounded generation

/** The heavy compositional call types Advanced Mode upgrades to Opus. */
const HEAVY_CALL_TYPES: ReadonlySet<ModelCallType> = new Set<ModelCallType>([
  'whole_score',
  'extend',
])

/**
 * Resolve the provider model-size {@link Tier} for a generation call.
 * See the module-level doc block for the full escalation ladder.
 */
export function resolveModelClass(opts: {
  advancedComposer?: boolean
  callType: ModelCallType
  complexity?: 'simple' | 'complex'
}): Tier {
  if (opts.advancedComposer === true && HEAVY_CALL_TYPES.has(opts.callType)) return 'large'
  if (opts.complexity === 'complex') return 'medium'
  return 'small'
}
