// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  costToCredits,
  fallbackCreditsForKind,
  MARKUP_EDIT,
  MARKUP_GENERATE,
  markupForKind,
  VALUE_TIERS,
  worstCaseHoldCredits,
} from '@/lib/billing/valueTier'

describe('costToCredits (cost-plus, round UP, 1-credit floor)', () => {
  it('reproduces the locked generation anchors at the 2.5× markup', () => {
    // 1 credit = 1¢ = 10_000 µUSD; credits = ceil(µUSD × markup / 10_000)
    expect(costToCredits(90_000, MARKUP_GENERATE)).toBe(23) // ~$0.09 warm → 22.5 → 23
    expect(costToCredits(160_000, MARKUP_GENERATE)).toBe(40) // ~$0.16 cold → 40
    expect(costToCredits(300_000, MARKUP_GENERATE)).toBe(75) // ~$0.30 Opus → 75
  })

  it('applies the gentler 1.2× edit markup', () => {
    expect(costToCredits(90_000, MARKUP_EDIT)).toBe(11) // 10.8 → 11
    expect(costToCredits(30_000, MARKUP_EDIT)).toBe(4) // 3.6 → 4
  })

  it('floors a tiny positive cost at 1 credit (never charges 0 for real work)', () => {
    expect(costToCredits(1_000, MARKUP_EDIT)).toBe(1) // 0.12 → floor 1
    expect(costToCredits(1, MARKUP_GENERATE)).toBe(1)
  })

  it('returns 0 for a non-positive / non-finite cost (caller applies the fallback)', () => {
    expect(costToCredits(0, MARKUP_GENERATE)).toBe(0)
    expect(costToCredits(-5, MARKUP_GENERATE)).toBe(0)
    expect(costToCredits(Number.NaN, MARKUP_GENERATE)).toBe(0)
    expect(costToCredits(Number.POSITIVE_INFINITY, MARKUP_GENERATE)).toBe(0)
  })
})

describe('markupForKind', () => {
  it('edits → 1.2×, everything else → 2.5×', () => {
    expect(markupForKind('edit_score_level')).toBe(MARKUP_EDIT)
    expect(markupForKind('edit_intra_measure')).toBe(MARKUP_EDIT)
    expect(markupForKind('generate_simple')).toBe(MARKUP_GENERATE)
    expect(markupForKind('generate_complex')).toBe(MARKUP_GENERATE)
    expect(markupForKind('compose')).toBe(MARKUP_GENERATE)
    expect(markupForKind('converse')).toBe(MARKUP_GENERATE)
  })
})

describe('fallbackCreditsForKind (fail-closed flat charge when cost is unreadable)', () => {
  it('edits get the small edit anchor; generations the standard anchor', () => {
    expect(fallbackCreditsForKind('edit_score_level')).toBe(VALUE_TIERS.edit)
    expect(fallbackCreditsForKind('edit_intra_measure')).toBe(VALUE_TIERS.edit)
    expect(fallbackCreditsForKind('generate_complex')).toBe(VALUE_TIERS.standard)
    expect(fallbackCreditsForKind('compose')).toBe(VALUE_TIERS.standard)
  })
})

describe('VALUE_TIERS anchors', () => {
  it('are the locked display anchors', () => {
    expect(VALUE_TIERS).toEqual({ edit: 5, standard: 25, full: 60, opus: 150 })
  })
})

describe('worstCaseHoldCredits (provable upper bound, creditsCharged ≤ hold)', () => {
  it('covers the priciest outcome — a 12-section sectional (8000 max_tokens) → 491 credits', () => {
    // max(non-streaming 3×Sonnet(80k+8k), sectional 12×Sonnet(12k+8k)) + overhead, ×2.5.
    expect(worstCaseHoldCredits(8_000)).toBe(491)
  })

  it('stays at/below the $5 min pack (500 cr) so a min-pack buyer can start a generation', () => {
    expect(worstCaseHoldCredits(8_000)).toBeLessThanOrEqual(500)
  })

  it('is never below the standard anchor and dominates a typical charge', () => {
    expect(worstCaseHoldCredits(2_600)).toBeGreaterThanOrEqual(VALUE_TIERS.standard)
    // A typical warm generation (23 cr) and a realistic sectional (~$1 → 250 cr)
    // must be under the hold so settle doesn't routinely trip overHold.
    expect(worstCaseHoldCredits(8_000)).toBeGreaterThan(costToCredits(160_000, MARKUP_GENERATE))
    expect(worstCaseHoldCredits(8_000)).toBeGreaterThan(costToCredits(1_000_000, MARKUP_GENERATE))
  })
})
