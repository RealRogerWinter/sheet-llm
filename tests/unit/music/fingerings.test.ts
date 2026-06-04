import { describe, it, expect } from 'vitest'
import { EventSchema, FingeringSchema, type Event, type Fingering } from '@/lib/music/types'
import {
  formatFingering,
  getFingering,
  parseFingering,
  removeFingeringAt,
  setFingeringAt,
} from '@/lib/music/fingerings'
import { validateScore } from '@/lib/music/validateScore'

describe('FingeringSchema — piano', () => {
  it('accepts a basic piano fingering 0-5', () => {
    for (const v of ['0', '1', '2', '3', '4', '5'] as const) {
      const f: Fingering = { system: 'piano', value: v }
      expect(() => FingeringSchema.parse(f)).not.toThrow()
    }
  })
  it('accepts substitution string', () => {
    expect(() =>
      FingeringSchema.parse({ system: 'piano', value: '3', substitution: '3-2' }),
    ).not.toThrow()
  })
  it('rejects piano value 6', () => {
    expect(() => FingeringSchema.parse({ system: 'piano', value: '6' })).toThrow()
  })
})

describe('FingeringSchema — string', () => {
  it('accepts finger 0-4 with optional Roman string', () => {
    expect(() => FingeringSchema.parse({ system: 'string', finger: 0 })).not.toThrow()
    expect(() => FingeringSchema.parse({ system: 'string', finger: 4 })).not.toThrow()
    expect(() =>
      FingeringSchema.parse({ system: 'string', finger: 3, stringRoman: 'III' }),
    ).not.toThrow()
  })
  it('rejects finger 5 (strings use 0-4)', () => {
    expect(() => FingeringSchema.parse({ system: 'string', finger: 5 })).toThrow()
  })
  it('rejects invalid Roman numeral', () => {
    expect(() =>
      FingeringSchema.parse({ system: 'string', finger: 1, stringRoman: 'V' }),
    ).toThrow()
  })
})

describe('FingeringSchema — guitar LH/RH', () => {
  it('guitar-lh accepts 1-4 + string + fret', () => {
    expect(() =>
      FingeringSchema.parse({ system: 'guitar-lh', value: 1 }),
    ).not.toThrow()
    expect(() =>
      FingeringSchema.parse({ system: 'guitar-lh', value: 3, stringNum: 6, fret: 'V' }),
    ).not.toThrow()
  })
  it('guitar-lh rejects value 0 (no open-string finger in LH numbering)', () => {
    expect(() => FingeringSchema.parse({ system: 'guitar-lh', value: 0 })).toThrow()
  })
  it('guitar-rh accepts Spanish letters', () => {
    for (const v of ['p', 'i', 'm', 'a', 'c'] as const) {
      expect(() => FingeringSchema.parse({ system: 'guitar-rh', value: v })).not.toThrow()
    }
  })
  it('guitar-rh rejects unknown letters', () => {
    expect(() => FingeringSchema.parse({ system: 'guitar-rh', value: 'x' })).toThrow()
  })
})

describe('FingeringSchema — organ', () => {
  it('accepts 0-5 + heel/toe + thumb direction', () => {
    expect(() => FingeringSchema.parse({ system: 'organ', value: '3' })).not.toThrow()
    expect(() =>
      FingeringSchema.parse({ system: 'organ', value: '0', foot: 'heel' }),
    ).not.toThrow()
    expect(() =>
      FingeringSchema.parse({ system: 'organ', value: '1', thumbDirection: '(' }),
    ).not.toThrow()
  })
})

describe('discriminated union — rejects mismatched system + fields', () => {
  it('piano shape rejected with string-system tag', () => {
    expect(() =>
      FingeringSchema.parse({ system: 'string', value: '3' }),
    ).toThrow()
  })
  it('guitar-rh tag rejects numeric value', () => {
    expect(() =>
      FingeringSchema.parse({ system: 'guitar-rh', value: 3 as never }),
    ).toThrow()
  })
})

describe('Event.fingerings array', () => {
  it('accepts an array of fingerings (one per chord pitch)', () => {
    const ev = {
      pitches: [
        { step: 'C' as const, octave: 4 },
        { step: 'E' as const, octave: 4 },
        { step: 'G' as const, octave: 4 },
      ],
      duration: 'quarter' as const,
      fingerings: [
        { system: 'piano' as const, value: '1' as const },
        { system: 'piano' as const, value: '3' as const },
        { system: 'piano' as const, value: '5' as const },
      ],
    }
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('accepts an empty fingerings array (legal, just an empty list)', () => {
    const ev = {
      pitches: [{ step: 'C' as const, octave: 4 }],
      duration: 'quarter' as const,
      fingerings: [],
    }
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('caps fingerings at 6 (matching max pitches per chord)', () => {
    const tooMany = Array.from({ length: 7 }, () => ({
      system: 'piano' as const,
      value: '1' as const,
    }))
    expect(() =>
      EventSchema.parse({
        pitches: [{ step: 'C' as const, octave: 4 }],
        duration: 'quarter' as const,
        fingerings: tooMany,
      }),
    ).toThrow()
  })

  it('supports mixed fingering systems on the same event (cross-instrument cue notes)', () => {
    const ev = {
      pitches: [
        { step: 'C' as const, octave: 4 },
        { step: 'E' as const, octave: 4 },
      ],
      duration: 'quarter' as const,
      fingerings: [
        { system: 'piano' as const, value: '1' as const },
        { system: 'guitar-rh' as const, value: 'i' as const },
      ],
    }
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })
})

describe('Full-score round-trip with fingerings', () => {
  it('validates a fingered piano chord in a real score', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C' as const, octave: 4 },
                { step: 'E' as const, octave: 4 },
                { step: 'G' as const, octave: 4 },
              ],
              duration: 'whole' as const,
              fingerings: [
                { system: 'piano' as const, value: '1' as const },
                { system: 'piano' as const, value: '3' as const },
                { system: 'piano' as const, value: '5' as const },
              ],
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates a string-fingered note with Roman numeral', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C' as const, octave: 4 }],
              duration: 'whole' as const,
              fingerings: [
                { system: 'string' as const, finger: 3 as const, stringRoman: 'III' as const },
              ],
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('back-compat: legacy score without fingerings still validates', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [{ pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const }],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('accepts null entries for interior gaps (skip-this-pitch sentinel)', () => {
    // Piano chord where only the top pitch is fingered — null slots
    // hold the place for the lower pitches without inventing a fake
    // fingering for them.
    const ev = {
      pitches: [
        { step: 'C' as const, octave: 4 },
        { step: 'E' as const, octave: 4 },
        { step: 'G' as const, octave: 4 },
      ],
      duration: 'quarter' as const,
      fingerings: [null, null, { system: 'piano' as const, value: '5' as const }],
    }
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })
})

describe('fingerings helpers', () => {
  const chordEvent: Event = {
    pitches: [
      { step: 'C', octave: 4 },
      { step: 'E', octave: 4 },
      { step: 'G', octave: 4 },
    ],
    duration: 'quarter',
  }

  describe('getFingering', () => {
    it('returns undefined when no fingerings array is set', () => {
      expect(getFingering(chordEvent, 0)).toBeUndefined()
    })

    it('returns the fingering at the requested pitchIdx', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [
          { system: 'piano', value: '1' },
          { system: 'piano', value: '3' },
          { system: 'piano', value: '5' },
        ],
      }
      expect(getFingering(ev, 1)).toEqual({ system: 'piano', value: '3' })
    })

    it('returns undefined for null slots (skip-this-pitch)', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [null, null, { system: 'piano', value: '5' }],
      }
      expect(getFingering(ev, 0)).toBeUndefined()
      expect(getFingering(ev, 2)).toEqual({ system: 'piano', value: '5' })
    })

    it('returns undefined for trailing pitches beyond the array length', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [{ system: 'piano', value: '1' }],
      }
      expect(getFingering(ev, 2)).toBeUndefined()
    })
  })

  describe('setFingeringAt', () => {
    it('sets a fingering on a previously-unfingered event', () => {
      const next = setFingeringAt(chordEvent, 0, { system: 'piano', value: '1' })
      expect(next.fingerings).toEqual([{ system: 'piano', value: '1' }])
    })

    it('pads earlier slots with null when fingering a later pitch first', () => {
      // User clicks pitch [2] of a 3-note chord without fingering [0]/[1].
      // The result holds nulls for the missing slots so indexing stays
      // aligned with the pitches array.
      const next = setFingeringAt(chordEvent, 2, { system: 'piano', value: '5' })
      expect(next.fingerings).toEqual([null, null, { system: 'piano', value: '5' }])
    })

    it('overwrites an existing entry in place without disturbing siblings', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [
          { system: 'piano', value: '1' },
          { system: 'piano', value: '3' },
          { system: 'piano', value: '5' },
        ],
      }
      const next = setFingeringAt(ev, 1, { system: 'piano', value: '2' })
      expect(next.fingerings).toEqual([
        { system: 'piano', value: '1' },
        { system: 'piano', value: '2' },
        { system: 'piano', value: '5' },
      ])
    })

    it('preserves later slots when overwriting an earlier one', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [null, null, { system: 'piano', value: '5' }],
      }
      const next = setFingeringAt(ev, 0, { system: 'piano', value: '1' })
      expect(next.fingerings).toEqual([
        { system: 'piano', value: '1' },
        null,
        { system: 'piano', value: '5' },
      ])
    })
  })

  describe('removeFingeringAt', () => {
    it('clears the slot and trims trailing nulls', () => {
      // The middle pitch is removed; the trailing fingering stays put,
      // so the result keeps a 3-slot array with the cleared slot now null.
      const ev: Event = {
        ...chordEvent,
        fingerings: [
          { system: 'piano', value: '1' },
          { system: 'piano', value: '3' },
          { system: 'piano', value: '5' },
        ],
      }
      const next = removeFingeringAt(ev, 1)
      expect(next.fingerings).toEqual([
        { system: 'piano', value: '1' },
        null,
        { system: 'piano', value: '5' },
      ])
    })

    it('trims trailing nulls after removal of the last fingering', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [
          { system: 'piano', value: '1' },
          { system: 'piano', value: '3' },
          { system: 'piano', value: '5' },
        ],
      }
      const next = removeFingeringAt(ev, 2)
      expect(next.fingerings).toEqual([
        { system: 'piano', value: '1' },
        { system: 'piano', value: '3' },
      ])
    })

    it('drops the fingerings key entirely when the array would be empty', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [{ system: 'piano', value: '1' }],
      }
      const next = removeFingeringAt(ev, 0)
      expect(next.fingerings).toBeUndefined()
      expect('fingerings' in next).toBe(false)
    })

    it('is a no-op when no fingerings exist', () => {
      const next = removeFingeringAt(chordEvent, 0)
      expect(next).toEqual(chordEvent)
    })

    it('is a no-op for out-of-range pitchIdx', () => {
      const ev: Event = {
        ...chordEvent,
        fingerings: [{ system: 'piano', value: '1' }],
      }
      const next = removeFingeringAt(ev, 5)
      expect(next.fingerings).toEqual([{ system: 'piano', value: '1' }])
    })
  })
})

describe('parseFingering', () => {
  it('returns undefined for empty input', () => {
    expect(parseFingering('')).toBeUndefined()
    expect(parseFingering('  ')).toBeUndefined()
  })

  it('parses a bare digit 0-5 as piano (the ambiguous-default system)', () => {
    for (const d of ['0', '1', '2', '3', '4', '5']) {
      expect(parseFingering(d)).toEqual({ system: 'piano', value: d })
    }
  })

  it('parses a piano substitution like "3-2" or "1>2"', () => {
    expect(parseFingering('3-2')).toEqual({
      system: 'piano',
      value: '3',
      substitution: '3-2',
    })
    expect(parseFingering('1>2')).toEqual({
      system: 'piano',
      value: '1',
      substitution: '1>2',
    })
  })

  it('parses guitar-rh Spanish letters', () => {
    for (const letter of ['p', 'i', 'm', 'a', 'c'] as const) {
      expect(parseFingering(letter)).toEqual({ system: 'guitar-rh', value: letter })
    }
  })

  it('parses a string fingering "N.RR" with Roman string indicator', () => {
    expect(parseFingering('1.IV')).toEqual({
      system: 'string',
      finger: 1,
      stringRoman: 'IV',
    })
    expect(parseFingering('3.III')).toEqual({
      system: 'string',
      finger: 3,
      stringRoman: 'III',
    })
  })

  it('parses organ heel/toe shorthand "Nh" / "Nt"', () => {
    expect(parseFingering('1h')).toEqual({ system: 'organ', value: '1', foot: 'heel' })
    expect(parseFingering('2t')).toEqual({ system: 'organ', value: '2', foot: 'toe' })
    // Case-insensitive
    expect(parseFingering('1H')).toEqual({ system: 'organ', value: '1', foot: 'heel' })
  })

  it('parses organ thumb-direction "N(" / "N)"', () => {
    expect(parseFingering('1(')).toEqual({
      system: 'organ',
      value: '1',
      thumbDirection: '(',
    })
    expect(parseFingering('3)')).toEqual({
      system: 'organ',
      value: '3',
      thumbDirection: ')',
    })
  })

  it('parses guitar-lh with explicit prefix and optional stringNum + fret', () => {
    expect(parseFingering('lh:1')).toEqual({ system: 'guitar-lh', value: 1 })
    expect(parseFingering('lh:2(6)')).toEqual({
      system: 'guitar-lh',
      value: 2,
      stringNum: 6,
    })
    expect(parseFingering('lh:3/V')).toEqual({
      system: 'guitar-lh',
      value: 3,
      fret: 'V',
    })
    expect(parseFingering('lh:4(1)/X')).toEqual({
      system: 'guitar-lh',
      value: 4,
      stringNum: 1,
      fret: 'X',
    })
  })

  it('accepts explicit system prefixes for disambiguation', () => {
    expect(parseFingering('piano:3')).toEqual({ system: 'piano', value: '3' })
    expect(parseFingering('string:2.III')).toEqual({
      system: 'string',
      finger: 2,
      stringRoman: 'III',
    })
    expect(parseFingering('rh:m')).toEqual({ system: 'guitar-rh', value: 'm' })
    expect(parseFingering('organ:3h')).toEqual({
      system: 'organ',
      value: '3',
      foot: 'heel',
    })
  })

  it('returns undefined for unrecognized input', () => {
    expect(parseFingering('xyz')).toBeUndefined()
    expect(parseFingering('99')).toBeUndefined()
    // Piano caps at 5
    expect(parseFingering('6')).toBeUndefined()
    // No "L" suffix in the schema — left/right hand discriminator is a
    // future addition tracked in [[project-phase1-plan]].
    expect(parseFingering('2L')).toBeUndefined()
    // Invalid Roman
    expect(parseFingering('1.V')).toBeUndefined()
    // string-system fingers cap at 4
    expect(parseFingering('string:5')).toBeUndefined()
    // guitar-lh starts at 1 (no open string)
    expect(parseFingering('lh:0')).toBeUndefined()
    // fret Roman caps at 5 chars (matches GuitarLHFingeringSchema.fret.max(5));
    // an oversized fret string would otherwise bypass Zod via transformScore
    // and land unvalidated in the store.
    expect(parseFingering('lh:1/IIIIII')).toBeUndefined()
  })

  it('the parser output round-trips through Zod FingeringSchema for the common forms', () => {
    for (const text of ['1', '3-2', 'p', '1.IV', '2h', '3(', 'lh:2(6)/V']) {
      const parsed = parseFingering(text)
      expect(parsed, `parseFingering(${text}) should produce a result`).toBeDefined()
      expect(() => FingeringSchema.parse(parsed)).not.toThrow()
    }
  })
})

describe('formatFingering', () => {
  it('formats a piano digit', () => {
    expect(formatFingering({ system: 'piano', value: '3' })).toBe('3')
  })

  it('formats a piano substitution as the literal substitution string', () => {
    expect(formatFingering({ system: 'piano', value: '3', substitution: '3-2' })).toBe('3-2')
  })

  it('formats a string fingering with and without Roman indicator', () => {
    expect(formatFingering({ system: 'string', finger: 0 })).toBe('0')
    expect(formatFingering({ system: 'string', finger: 1, stringRoman: 'IV' })).toBe('1.IV')
  })

  it('formats a guitar-lh fingering with optional stringNum + fret', () => {
    expect(formatFingering({ system: 'guitar-lh', value: 1 })).toBe('1')
    expect(formatFingering({ system: 'guitar-lh', value: 2, stringNum: 6 })).toBe('2(6)')
    expect(
      formatFingering({ system: 'guitar-lh', value: 3, stringNum: 1, fret: 'V' }),
    ).toBe('3(1)/V')
  })

  it('formats a guitar-rh letter directly', () => {
    expect(formatFingering({ system: 'guitar-rh', value: 'p' })).toBe('p')
  })

  it('formats an organ fingering with foot and thumb-direction', () => {
    expect(formatFingering({ system: 'organ', value: '1', foot: 'heel' })).toBe('1h')
    expect(formatFingering({ system: 'organ', value: '2', foot: 'toe' })).toBe('2t')
    expect(formatFingering({ system: 'organ', value: '1', thumbDirection: '(' })).toBe('1(')
  })

  it('round-trips unambiguous forms through parse → format', () => {
    // Forms that have a unique surface representation across systems
    // round-trip cleanly. String-fingers-without-Roman and guitar-lh-
    // without-prefix can't because "2" formats and re-parses to piano
    // (the ambiguous default) — those need the explicit-prefix form.
    const cases: Fingering[] = [
      { system: 'piano', value: '3' },
      { system: 'piano', value: '1', substitution: '1-2' },
      { system: 'string', finger: 4, stringRoman: 'III' },
      { system: 'guitar-rh', value: 'a' },
      { system: 'organ', value: '0', foot: 'heel' },
      { system: 'organ', value: '5', thumbDirection: ')' },
    ]
    for (const f of cases) {
      const text = formatFingering(f)
      const back = parseFingering(text)
      expect(back, `format→parse round-trip failed for ${JSON.stringify(f)}`).toEqual(f)
    }
  })

  it('format(string-finger-without-Roman) re-parses to piano (the documented ambiguity)', () => {
    // Documented limitation: when the only shorthand is a bare digit,
    // the parser cannot recover which instrument the fingering belonged
    // to. The pre-fill seed in FingeringPopover is still useful — the
    // user sees "2" and types the system prefix if they need a non-piano
    // system. Document the limitation here so a future test author
    // can't tighten the round-trip silently.
    const f: Fingering = { system: 'string', finger: 2 }
    const back = parseFingering(formatFingering(f))
    expect(back).toEqual({ system: 'piano', value: '2' })
  })
})
