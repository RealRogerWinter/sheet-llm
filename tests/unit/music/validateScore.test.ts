import { describe, it, expect } from 'vitest'
import { validateScore, validateAbc } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'

function quarter(step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B') {
  return { pitches: [{ step, octave: 4 }], duration: 'quarter' as const }
}

describe('validateScore — schema', () => {
  it('accepts a minimal valid score', () => {
    const ok = validateScore({
      key: 'C',
      meter: '4/4',
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    })
    expect(ok.key).toBe('C')
  })

  it('accepts a grand-staff score with bar-aligned secondStaff', () => {
    const ok = validateScore({
      key: 'C',
      meter: '4/4',
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
      },
    })
    expect(ok.secondStaff?.clef).toBe('bass')
  })

  it('accepts an SATB score with two voices per staff and matching measure counts', () => {
    const events4 = [quarter('C'), quarter('D'), quarter('E'), quarter('F')]
    const eventsLow = [
      { pitches: [{ step: 'C' as const, octave: 3 }], duration: 'quarter' as const },
      { pitches: [{ step: 'D' as const, octave: 3 }], duration: 'quarter' as const },
      { pitches: [{ step: 'E' as const, octave: 3 }], duration: 'quarter' as const },
      { pitches: [{ step: 'F' as const, octave: 3 }], duration: 'quarter' as const },
    ]
    const ok = validateScore({
      key: 'C',
      meter: '4/4',
      measures: [{ events: events4 }],
      extraVoices: [{ measures: [{ events: events4 }] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: eventsLow }],
        extraVoices: [{ measures: [{ events: eventsLow }] }],
      },
    })
    expect(ok.extraVoices).toHaveLength(1)
    expect(ok.secondStaff?.extraVoices).toHaveLength(1)
  })

  it('rejects an SATB score where one voice has a different measure count', () => {
    const events4 = [quarter('C'), quarter('D'), quarter('E'), quarter('F')]
    expect(() =>
      validateScore({
        key: 'C',
        meter: '4/4',
        measures: [{ events: events4 }, { events: events4 }],
        // alto only has 1 measure; primary has 2 — bar-alignment broken.
        extraVoices: [{ measures: [{ events: events4 }] }],
      }),
    ).toThrow(ValidationError)
  })

  it('rejects a grand-staff score with mismatched measure counts', () => {
    expect(() =>
      validateScore({
        key: 'C',
        meter: '4/4',
        measures: [
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
          { events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] },
        ],
        secondStaff: {
          clef: 'bass',
          measures: [
            // Only one measure where the primary has two — bar alignment broken.
            { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          ],
        },
      }),
    ).toThrow(ValidationError)
  })

  it('rejects unknown key', () => {
    expect(() => validateScore({
      key: 'H',
      meter: '4/4',
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    })).toThrow(ValidationError)
  })

  it('rejects measures: []', () => {
    expect(() => validateScore({ key: 'C', meter: '4/4', measures: [] })).toThrow(ValidationError)
  })

  it('rejects pitches: []', () => {
    expect(() => validateScore({
      key: 'C', meter: '4/4',
      measures: [{ events: [{ pitches: [], duration: 'quarter' }] }],
    })).toThrow(ValidationError)
  })

  it('rejects octave out of range', () => {
    expect(() => validateScore({
      key: 'C', meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 10 }], duration: 'whole' }] }],
    })).toThrow(ValidationError)
  })
})

describe('validateScore — semantic', () => {
  it('throws on measure duration mismatch', () => {
    expect(() => validateScore({
      key: 'C', meter: '4/4',
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E')] }], // 3 quarters, expected 4
    })).toThrow(ValidationError)
  })

  it('accepts a valid 6/8 measure (dotted-quarter + 3 eighths)', () => {
    const ok = validateScore({
      key: 'C', meter: '6/8',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'dotted-quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth' },
      ] }],
    })
    expect(ok.meter).toBe('6/8')
  })

  it('accepts triplets that sum correctly', () => {
    // 4 quarter-triplets at the triplet level = ... let's use 3 eighth-triplets
    // 3 eighth-triplets = 3 × (1 × 2/3) = 2 eighths worth = quarter
    // So 1 triplet + 3 quarters = 1 quarter + 3 quarters = 4 quarters = 4/4
    const ok = validateScore({
      key: 'C', meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        quarter('F'), quarter('G'), quarter('A'),
      ] }],
    })
    expect(ok.measures).toHaveLength(1)
  })

  it('throws on incomplete tuplet group', () => {
    expect(() => validateScore({
      key: 'C', meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        quarter('F'), quarter('G'), quarter('A'), { pitches: [{ step: 'B', octave: 4 }], duration: 'eighth' }, { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
      ] }],
    })).toThrow(ValidationError)
  })

  it('throws on rest inside chord', () => {
    expect(() => validateScore({
      key: 'C', meter: '4/4',
      measures: [{ events: [{ pitches: [
        { step: 'C', octave: 4 },
        { step: 'rest', octave: 4 },
      ], duration: 'whole' }] }],
    })).toThrow(ValidationError)
  })
})

describe('validateScore — odd meters', () => {
  it('accepts a 5/4 measure (5 quarters)', () => {
    const ok = validateScore({
      key: 'Am', meter: '5/4',
      measures: [{ events: [
        quarter('A'), quarter('B'), quarter('C'), quarter('D'), quarter('E'),
      ] }],
    })
    expect(ok.meter).toBe('5/4')
  })

  it('accepts a 7/8 measure (7 eighths)', () => {
    const ok = validateScore({
      key: 'C', meter: '7/8',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'eighth' },
      ] }],
    })
    expect(ok.meter).toBe('7/8')
  })

  it('accepts an 11/8 measure', () => {
    const eighth = (step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B') => ({
      pitches: [{ step, octave: 4 }], duration: 'eighth' as const,
    })
    const ok = validateScore({
      key: 'C', meter: '11/8',
      measures: [{ events: [
        eighth('C'), eighth('D'), eighth('E'), eighth('F'),
        eighth('G'), eighth('A'), eighth('B'),
        eighth('C'), eighth('D'), eighth('E'), eighth('F'),
      ] }],
    })
    expect(ok.meter).toBe('11/8')
  })

  it('accepts a 5/16 measure (5 sixteenths = 2.5 eighths)', () => {
    const sixteenth = (step: 'C' | 'D' | 'E') => ({
      pitches: [{ step, octave: 4 }], duration: 'sixteenth' as const,
    })
    const ok = validateScore({
      key: 'C', meter: '5/16',
      measures: [{ events: [
        sixteenth('C'), sixteenth('D'), sixteenth('E'), sixteenth('D'), sixteenth('C'),
      ] }],
    })
    expect(ok.meter).toBe('5/16')
  })

  it('accepts a 7/32 measure (7 32nds = 1.75 eighths)', () => {
    const t32 = (step: 'C' | 'D' | 'E') => ({
      pitches: [{ step, octave: 4 }], duration: '32nd' as const,
    })
    const ok = validateScore({
      key: 'C', meter: '7/32',
      measures: [{ events: [
        t32('C'), t32('D'), t32('E'), t32('D'), t32('C'), t32('D'), t32('E'),
      ] }],
    })
    expect(ok.meter).toBe('7/32')
  })

  it('throws on a 5/4 measure that sums to 9 eighths (4 quarters + 1 eighth)', () => {
    expect(() => validateScore({
      key: 'Am', meter: '5/4',
      measures: [{ events: [
        quarter('A'), quarter('B'), quarter('C'), quarter('D'),
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth' },
      ] }],
    })).toThrow(/5\/4/)
  })

  it('rejects an unsupported meter at the schema level', () => {
    expect(() => validateScore({
      key: 'C', meter: '4/3',
      measures: [{ events: [quarter('C'), quarter('D'), quarter('E'), quarter('F')] }],
    })).toThrow(ValidationError)
  })
})

describe('validateAbc', () => {
  it('returns a warnings array on valid ABC', async () => {
    const result = await validateAbc('X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nCDEF GABc|')
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('handles a complex multi-measure tune', async () => {
    const abc = 'X:1\nT:Two bars\nM:4/4\nL:1/8\nK:Bb\nB2c2d2f2|f2d2c2B2|'
    const result = await validateAbc(abc)
    expect(Array.isArray(result.warnings)).toBe(true)
  })
  // Note: abcjs is permissive — even malformed/empty input often parses
  // to a (possibly warning-laden) tune object. A hard parse failure is
  // hard to construct deterministically, so we don't test that path
  // here; the retry pipeline keys off `warnings.length` for soft issues.
})
