// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  costToCredits,
  DEFAULT_FREE_PIECE_BUDGET_CREDITS,
  DEFAULT_MAX_GENERATION_HOLD_CREDITS,
  fallbackCreditsForKind,
  freePieceBudgetCredits,
  generationHoldCredits,
  MARKUP_EDIT,
  MARKUP_GENERATE,
  markupForKind,
  maxGenerationHoldCredits,
  sectionAbortMarginCredits,
  VALUE_TIERS,
  WORST_MODEL_ADVANCED,
  WORST_MODEL_STANDARD,
  worstCaseHoldCredits,
} from '@/lib/billing/valueTier'
import { PRICING } from '@/lib/billing/pricing'
import { getModelEntry } from '@/lib/providers/registry'

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

describe('maxGenerationHoldCredits (PR-7b-2c cap, operator-tunable)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to DEFAULT_MAX_GENERATION_HOLD_CREDITS when unset', () => {
    expect(maxGenerationHoldCredits()).toBe(DEFAULT_MAX_GENERATION_HOLD_CREDITS)
    expect(DEFAULT_MAX_GENERATION_HOLD_CREDITS).toBe(1_500)
  })

  it('honors a valid SL_MAX_GEN_HOLD_CREDITS override', () => {
    vi.stubEnv('SL_MAX_GEN_HOLD_CREDITS', '3000')
    expect(maxGenerationHoldCredits()).toBe(3_000)
  })

  it('falls back to the default on a non-positive / non-integer / garbage value', () => {
    for (const bad of ['0', '-5', 'abc', '1500.5', '']) {
      vi.stubEnv('SL_MAX_GEN_HOLD_CREDITS', bad)
      expect(maxGenerationHoldCredits()).toBe(DEFAULT_MAX_GENERATION_HOLD_CREDITS)
    }
  })
})

describe('generationHoldCredits (fork b: min(available, cap), floored at worst case)', () => {
  afterEach(() => vi.unstubAllEnvs())
  const FLOOR = worstCaseHoldCredits(8_000) // 491
  const CAP = DEFAULT_MAX_GENERATION_HOLD_CREDITS // 1500

  it('returns the AVAILABLE balance when between the floor and the cap', () => {
    expect(generationHoldCredits(1_000, 8_000)).toBe(1_000)
    expect(generationHoldCredits(FLOOR, 8_000)).toBe(FLOOR)
    expect(generationHoldCredits(CAP, 8_000)).toBe(CAP)
  })

  it('caps at maxGenerationHoldCredits for a rich balance', () => {
    expect(generationHoldCredits(5_000, 8_000)).toBe(CAP)
    expect(generationHoldCredits(Number.MAX_SAFE_INTEGER, 8_000)).toBe(CAP)
  })

  it('never returns below the worst-case floor (the caller gates available >= floor)', () => {
    expect(generationHoldCredits(0, 8_000)).toBe(FLOOR)
    expect(generationHoldCredits(300, 8_000)).toBe(FLOOR)
    expect(generationHoldCredits(Number.NaN, 8_000)).toBe(FLOOR)
  })

  it('floors the cap at the worst case even when the operator sets a tiny cap', () => {
    vi.stubEnv('SL_MAX_GEN_HOLD_CREDITS', '100') // below the 491 floor
    expect(generationHoldCredits(5_000, 8_000)).toBe(FLOOR) // never under the floor
  })

  it('floors to integer credits for a fractional balance', () => {
    expect(generationHoldCredits(1_000.9, 8_000)).toBe(1_000)
  })
})

describe('sectionAbortMarginCredits (PR-7b-2c sectional abort headroom)', () => {
  it('bounds one section cost-plus charge: Sonnet 48k in + 8k out → 66 cr', () => {
    // (48_000×$3 + 8_000×$15) / 1e6 = $0.264 → ×2.5 / 1¢ = 66 credits. Generous over
    // a real ~16k-input section (extendComposition sends only metadata + 4 trailing bars).
    expect(sectionAbortMarginCredits(8_000)).toBe(66)
  })

  it('stays BELOW the hold floor so the abort threshold (hold − margin) is positive', () => {
    expect(sectionAbortMarginCredits(8_000)).toBeGreaterThan(0)
    expect(sectionAbortMarginCredits(8_000)).toBeLessThan(worstCaseHoldCredits(8_000))
  })
})

describe('freePieceBudgetCredits (PR-7b-2c free-piece per-run cost ceiling)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to DEFAULT_FREE_PIECE_BUDGET_CREDITS when unset, leaving room above the margin', () => {
    expect(freePieceBudgetCredits()).toBe(DEFAULT_FREE_PIECE_BUDGET_CREDITS)
    expect(DEFAULT_FREE_PIECE_BUDGET_CREDITS).toBe(250)
    // A typical free piece must clear the abort margin to deliver multiple sections.
    expect(DEFAULT_FREE_PIECE_BUDGET_CREDITS).toBeGreaterThan(sectionAbortMarginCredits(8_000) * 2)
  })

  it('honors a valid SL_FREE_PIECE_BUDGET_CREDITS override; falls back on garbage', () => {
    vi.stubEnv('SL_FREE_PIECE_BUDGET_CREDITS', '120')
    expect(freePieceBudgetCredits()).toBe(120)
    for (const bad of ['0', '-1', 'abc', '']) {
      vi.stubEnv('SL_FREE_PIECE_BUDGET_CREDITS', bad)
      expect(freePieceBudgetCredits()).toBe(DEFAULT_FREE_PIECE_BUDGET_CREDITS)
    }
  })
})

describe('PR-8 Advanced Composer (Opus) hold sizing', () => {
  it('an Advanced turn is bounded by the Opus non-streaming cost only → 473 credits', () => {
    // 3×Opus(80k in @ $5/M + 8k out @ $25/M) = 3×$0.60 = $1.80; overhead (Sonnet,
    // classifier/planner/dispatcher never go Opus) = $0.09 → $1.89 ×2.5 / 1¢ = 473.
    // No sectional term: an Advanced turn bypasses the sectional stream.
    expect(worstCaseHoldCredits(8_000, true)).toBe(473)
  })

  it('the Advanced bound EXCLUDES the sectional term, the Standard bound INCLUDES it', () => {
    // Standard's worst case is the 12-section Sonnet sectional ($1.872), which
    // exceeds 3 Opus single-shot attempts ($1.80) — so the Advanced floor sits
    // just BELOW the Standard floor even though Opus is the pricier model. This
    // is correct: each floor bounds the path that tier can actually take.
    expect(worstCaseHoldCredits(8_000, false)).toBe(491)
    expect(worstCaseHoldCredits(8_000, true)).toBeLessThan(worstCaseHoldCredits(8_000, false))
  })

  it('stays at/below the $5 min pack (500 cr) so a min-pack buyer can start Advanced', () => {
    expect(worstCaseHoldCredits(8_000, true)).toBeLessThanOrEqual(500)
  })

  it('generationHoldCredits floors an Advanced hold at the Opus bound', () => {
    const advFloor = worstCaseHoldCredits(8_000, true)
    expect(generationHoldCredits(0, 8_000, true)).toBe(advFloor)
    expect(generationHoldCredits(advFloor, 8_000, true)).toBe(advFloor)
    // Between floor and cap → the available balance; above cap → the cap.
    expect(generationHoldCredits(900, 8_000, true)).toBe(900)
    expect(generationHoldCredits(5_000, 8_000, true)).toBe(DEFAULT_MAX_GENERATION_HOLD_CREDITS)
  })

  it('defaults to the Standard (Sonnet) bound when advanced is omitted (back-compat)', () => {
    expect(worstCaseHoldCredits(8_000)).toBe(worstCaseHoldCredits(8_000, false))
    expect(generationHoldCredits(1_000, 8_000)).toBe(generationHoldCredits(1_000, 8_000, false))
  })
})

describe('worst-case model constants stay in sync with the registry + pricing (drift guard)', () => {
  it('WORST_MODEL_STANDARD is the registry `medium` model and is priced', () => {
    expect(WORST_MODEL_STANDARD).toBe(getModelEntry('anthropic', 'medium')!.modelId)
    expect(PRICING[WORST_MODEL_STANDARD]).toBeDefined()
  })

  it('WORST_MODEL_ADVANCED is the registry `large` (Opus) model and is priced', () => {
    // If the `large` tier model changes (providers/registry.ts), this fails to
    // remind you to re-derive the Advanced hold bound — else an Opus turn could
    // be priced against the wrong model and under-provision its hold.
    expect(WORST_MODEL_ADVANCED).toBe(getModelEntry('anthropic', 'large')!.modelId)
    expect(PRICING[WORST_MODEL_ADVANCED]).toBeDefined()
  })

  it('the Advanced (Opus) model is strictly pricier than the Standard (Sonnet) model', () => {
    expect(PRICING[WORST_MODEL_ADVANCED].inputPerM).toBeGreaterThan(
      PRICING[WORST_MODEL_STANDARD].inputPerM,
    )
    expect(PRICING[WORST_MODEL_ADVANCED].outputPerM).toBeGreaterThan(
      PRICING[WORST_MODEL_STANDARD].outputPerM,
    )
  })
})
