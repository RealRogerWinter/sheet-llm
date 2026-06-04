import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  ALLOWED_DENOMINATORS,
  METER_PRESETS,
  MAX_NUMERATOR,
  isCompound,
  isValidMeter,
  meterCapacityIn32nds,
  meterInEighths,
  parseMeter,
} from '@/lib/music/meter'

describe('isValidMeter', () => {
  it('accepts every preset', () => {
    for (const m of METER_PRESETS) {
      expect(isValidMeter(m)).toBe(true)
    }
  })

  it('accepts arbitrary valid n/d combinations', () => {
    for (const m of ['1/32', '32/4', '11/8', '5/16', '7/32', '13/16', '17/8']) {
      expect(isValidMeter(m)).toBe(true)
    }
  })

  it('rejects malformed strings', () => {
    const rejects = [
      '', ' 4/4', '4/4 ', '04/4', '4/04', '4 / 4',
      '4.5/4', '-1/4', '+4/4',
      'c', 'c|', 'C |', 'C/4',
      '4',
    ]
    for (const r of rejects) {
      expect(isValidMeter(r), `expected '${r}' to be invalid`).toBe(false)
    }
  })

  it('rejects denominators outside the allowed power-of-two set', () => {
    for (const r of ['4/3', '4/5', '4/6', '4/7', '4/64', '4/128']) {
      expect(isValidMeter(r)).toBe(false)
    }
  })

  it('rejects out-of-range numerators', () => {
    expect(isValidMeter('33/4')).toBe(false)
    expect(isValidMeter('100/8')).toBe(false)
    expect(isValidMeter('0/4')).toBe(false)
    expect(isValidMeter('4/0')).toBe(false)
  })

  it('rejects non-string inputs', () => {
    expect(isValidMeter(null)).toBe(false)
    expect(isValidMeter(undefined)).toBe(false)
    expect(isValidMeter(123)).toBe(false)
    expect(isValidMeter({})).toBe(false)
  })
})

describe('parseMeter', () => {
  it('returns the fraction for n/d meters', () => {
    expect(parseMeter('5/4')).toEqual({ numerator: 5, denominator: 4 })
    expect(parseMeter('7/8')).toEqual({ numerator: 7, denominator: 8 })
    expect(parseMeter('5/16')).toEqual({ numerator: 5, denominator: 16 })
  })

  it('maps C → 4/4 and C| → 2/2', () => {
    expect(parseMeter('C')).toEqual({ numerator: 4, denominator: 4 })
    expect(parseMeter('C|')).toEqual({ numerator: 2, denominator: 2 })
  })

  it('throws on malformed input', () => {
    expect(() => parseMeter('garbage')).toThrow()
  })
})

describe('meterInEighths', () => {
  it('matches the existing fixed-set values bit-for-bit', () => {
    expect(meterInEighths('2/4')).toBe(4)
    expect(meterInEighths('3/4')).toBe(6)
    expect(meterInEighths('4/4')).toBe(8)
    expect(meterInEighths('6/8')).toBe(6)
    expect(meterInEighths('9/8')).toBe(9)
    expect(meterInEighths('12/8')).toBe(12)
    expect(meterInEighths('C')).toBe(8)
    expect(meterInEighths('C|')).toBe(4)
  })

  it('computes odd-meter capacities', () => {
    expect(meterInEighths('5/4')).toBe(10)
    expect(meterInEighths('7/4')).toBe(14)
    expect(meterInEighths('7/8')).toBe(7)
    expect(meterInEighths('11/8')).toBe(11)
    expect(meterInEighths('5/16')).toBe(2.5)
    expect(meterInEighths('7/32')).toBe(1.75)
  })
})

describe('meterCapacityIn32nds', () => {
  it('is integer-exact for every preset', () => {
    for (const m of METER_PRESETS) {
      const v = meterCapacityIn32nds(m)
      expect(Number.isInteger(v), `expected ${m} → ${v} to be an integer`).toBe(true)
    }
  })

  it('equals meterInEighths × 4', () => {
    for (const m of METER_PRESETS) {
      expect(meterCapacityIn32nds(m)).toBeCloseTo(meterInEighths(m) * 4, 10)
    }
  })

  it('returns the expected values for odd meters', () => {
    expect(meterCapacityIn32nds('5/4')).toBe(40)
    expect(meterCapacityIn32nds('7/8')).toBe(28)
    expect(meterCapacityIn32nds('5/16')).toBe(10)
    expect(meterCapacityIn32nds('7/32')).toBe(7)
  })
})

describe('isCompound', () => {
  it('flags the canonical compound meters', () => {
    expect(isCompound('6/8')).toBe(true)
    expect(isCompound('9/8')).toBe(true)
    expect(isCompound('12/8')).toBe(true)
  })

  it('does not flag simple meters', () => {
    expect(isCompound('2/4')).toBe(false)
    expect(isCompound('3/4')).toBe(false)
    expect(isCompound('4/4')).toBe(false)
    expect(isCompound('5/4')).toBe(false)
    expect(isCompound('7/8')).toBe(false)
  })
})

describe('property-based: any n/d in spec is round-tripped exactly', () => {
  it('every (n ∈ [1,32], d ∈ allowed) is valid and integer-capacity in 32nds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_NUMERATOR }),
        fc.constantFrom(...ALLOWED_DENOMINATORS),
        (n, d) => {
          const m = `${n}/${d}`
          expect(isValidMeter(m)).toBe(true)
          const cap = meterCapacityIn32nds(m)
          expect(cap).toBe((n * 32) / d)
          expect(Number.isInteger(cap)).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('rejects denominators outside the allowed set', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_NUMERATOR }),
        fc.integer({ min: 3, max: 7 }).filter((d) => !(ALLOWED_DENOMINATORS as readonly number[]).includes(d)),
        (n, d) => {
          expect(isValidMeter(`${n}/${d}`)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects out-of-range numerators', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_NUMERATOR + 1, max: 9999 }),
        fc.constantFrom(...ALLOWED_DENOMINATORS),
        (n, d) => {
          expect(isValidMeter(`${n}/${d}`)).toBe(false)
        },
      ),
      { numRuns: 50 },
    )
  })
})
