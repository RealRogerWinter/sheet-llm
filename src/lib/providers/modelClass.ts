import type { Tier } from './types'

/**
 * THE model-class seam for "Advanced Composer Mode" (PR-8).
 *
 * Maps a generation call's INTENT (is this a heavy compositional call? is the
 * user's Advanced/Opus toggle on for this turn?) to the provider model-size
 * `Tier` that {@link import('./select').selectProvider} resolves to a concrete
 * model. This is the ONLY place that decides whether a call routes to the
 * Opus (`large`) tier, so the credit hold (sized for Opus in `valueTier.ts`)
 * and the routing can never drift apart.
 *
 * SELECTIVE routing (locked decision 6): only the heavy single-pass
 * compositional calls go Opus when Advanced is on —
 *   - `whole_score`: a single-shot whole-score emit (generateComplex /
 *     compose / regenerate_all)
 *   - `extend`: a standalone "extend the piece" call
 * Everything else — the classifier, planner, dispatcher, converse, the
 * free-tier bounded handler, intra-measure / structural edits, and the
 * SECTIONAL seed/extend loop (deliberately Sonnet-tuned; the Opus seed "was
 * taking minutes and its verbosity overflowed the token budget") — stays on
 * the standard `medium` (Sonnet) tier regardless of the toggle.
 *
 * TRUST BOUNDARY: `advancedComposer` must already be the RESOLVED entitlement —
 * the chat route only sets it true for an authenticated, paid Pro generation
 * (never free tier, never the free piece) and behind `SL_ADVANCED_COMPOSER`.
 * This function does NOT re-check that; it is the caller's responsibility, same
 * as `resolveGenerationTier` resolving the tier before it reaches a handler.
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
 * Returns `large` (Opus) ONLY for a heavy compositional call with the
 * Advanced toggle resolved-on; everything else returns `medium` (Sonnet).
 * Never returns `small` — the classifier/planner pick that explicitly.
 */
export function resolveModelClass(opts: {
  advancedComposer?: boolean
  callType: ModelCallType
}): Tier {
  return opts.advancedComposer === true && HEAVY_CALL_TYPES.has(opts.callType)
    ? 'large'
    : 'medium'
}
