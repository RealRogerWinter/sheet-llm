/**
 * Central definitions for time-signature handling. All meter math
 * downstream (validator, importers, smart-insert capacity check, UI
 * toolbar list, LLM tool schema) flows through this module so the
 * allowed set lives in exactly one place.
 *
 * This module deliberately does NOT import the `Meter` type from
 * types.ts — that would create a circular reference, because the
 * `Meter` type is inferred from `MeterSchema`, which uses
 * `isValidMeter` as its zod refinement. Parameters are typed as
 * `string` and consumers can pass any `Meter` value (which is just
 * `string` after zod inference).
 *
 * Validation rule for a Meter string:
 *   - the literals "C" (common time) or "C|" (cut time), OR
 *   - "n/d" where n ∈ [1, MAX_NUMERATOR] and d ∈ ALLOWED_DENOMINATORS.
 *
 * The numerator cap of 32 matches MeasureSchema's events.max(32) and
 * keeps abcjs beam-grouping in well-tested territory. The denominator
 * set is the powers of two for which the existing Duration enum has
 * a representable smallest event (32nd = 0.25 eighths); going to /64
 * would require a 64th-note duration we don't have.
 */

export const METER_PRESETS = [
  '2/4', '3/4', '4/4', '5/4',
  '6/8', '7/8', '9/8', '11/8', '12/8',
  'C', 'C|',
] as const

export const ALLOWED_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const
export const MAX_NUMERATOR = 32

const METER_FRACTION_RE = /^([1-9]\d*)\/([1-9]\d*)$/
const ALLOWED_DEN_SET: ReadonlySet<number> = new Set(ALLOWED_DENOMINATORS)

export function isValidMeter(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s === 'C' || s === 'C|') return true
  const m = s.match(METER_FRACTION_RE)
  if (!m) return false
  const num = Number(m[1])
  const den = Number(m[2])
  if (!Number.isInteger(num) || num < 1 || num > MAX_NUMERATOR) return false
  return ALLOWED_DEN_SET.has(den)
}

/**
 * Decompose a Meter into numerator/denominator. The symbolic forms
 * map to their musicological fractions: C → 4/4, C| → 2/2 (alla
 * breve). NOTE: meterInEighths / meterCapacityIn32nds intentionally
 * deviate from this for "C|" — see the comment on those functions.
 */
export function parseMeter(meter: string): { numerator: number; denominator: number } {
  if (meter === 'C') return { numerator: 4, denominator: 4 }
  if (meter === 'C|') return { numerator: 2, denominator: 2 }
  const m = meter.match(METER_FRACTION_RE)
  if (!m) throw new Error(`Invalid meter: ${String(meter)}`)
  return { numerator: Number(m[1]), denominator: Number(m[2]) }
}

/**
 * Measure capacity in eighth-note units (L:1/8 in ABC).
 *
 * Legacy quirk preserved: "C|" reports 4 eighths rather than the
 * musicologically-correct 8. The pre-existing codebase treated cut
 * time as a half-capacity 2/4-like bar, and every test, fixture, and
 * stored score depends on that convention. Don't "fix" it without
 * migrating all consumers.
 */
export function meterInEighths(meter: string): number {
  if (meter === 'C|') return 4
  const { numerator, denominator } = parseMeter(meter)
  return numerator * (8 / denominator)
}

/**
 * Measure capacity in 32nd-note units. Integer-exact for every
 * allowed meter (denominator divides 32), so consumers doing
 * subtractive arithmetic (smartInsertNote) can compare for equality
 * without epsilons.
 */
export function meterCapacityIn32nds(meter: string): number {
  if (meter === 'C|') return 16
  const { numerator, denominator } = parseMeter(meter)
  return numerator * (32 / denominator)
}

/**
 * Compound meter heuristic — advisory only. 6/8, 9/8, 12/8 are the
 * canonical compound meters (numerator divisible by 3, denominator
 * an eighth or smaller). Used for UI/labelling, not validation.
 */
export function isCompound(meter: string): boolean {
  const { numerator, denominator } = parseMeter(meter)
  return numerator >= 6 && numerator % 3 === 0 && denominator >= 8
}
