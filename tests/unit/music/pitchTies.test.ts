import { describe, it, expect } from 'vitest'
import {
  isEnharmonicTie,
  isLaissezVibrer,
  isPitchTiedToNext,
  tiedPitchIndices,
  withLaissezVibrer,
  withPitchTie,
} from '@/lib/music/pitchTies'
import { PitchSchema, type Pitch } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const C4: Pitch = { step: 'C', octave: 4 }
const E4: Pitch = { step: 'E', octave: 4 }
const G4: Pitch = { step: 'G', octave: 4 }

describe('isPitchTiedToNext', () => {
  it('returns true when pitch.tied_to_next is explicitly true', () => {
    expect(isPitchTiedToNext({ tied_to_next: true }, {})).toBe(true)
  })

  it('returns false when pitch.tied_to_next is explicitly false (overrides event-wide)', () => {
    expect(isPitchTiedToNext({ tied_to_next: false }, { tied_to_next: true })).toBe(false)
  })

  it('falls back to event.tied_to_next when pitch flag is absent', () => {
    expect(isPitchTiedToNext({}, { tied_to_next: true })).toBe(true)
    expect(isPitchTiedToNext({}, { tied_to_next: false })).toBe(false)
    expect(isPitchTiedToNext({}, {})).toBe(false)
  })

  it('pitch.tied_to_next: true wins over event.tied_to_next: false', () => {
    expect(isPitchTiedToNext({ tied_to_next: true }, { tied_to_next: false })).toBe(true)
  })
})

describe('isLaissezVibrer / isEnharmonicTie', () => {
  it('detects lv flag', () => {
    expect(isLaissezVibrer({ lv: true })).toBe(true)
    expect(isLaissezVibrer({ lv: false })).toBe(false)
    expect(isLaissezVibrer({})).toBe(false)
  })

  it('detects enharmonicTie flag', () => {
    expect(isEnharmonicTie({ enharmonicTie: true })).toBe(true)
    expect(isEnharmonicTie({ enharmonicTie: false })).toBe(false)
    expect(isEnharmonicTie({})).toBe(false)
  })
})

describe('tiedPitchIndices', () => {
  function quarterChord(pitches: Pitch[]) {
    return { pitches, duration: 'quarter' as const }
  }

  it('returns empty array when nothing is tied', () => {
    expect(tiedPitchIndices(quarterChord([C4, E4, G4]))).toEqual([])
  })

  it('returns indices of per-pitch-tied pitches in a chord', () => {
    const ev = quarterChord([
      { ...C4, tied_to_next: true },
      E4,
      { ...G4, tied_to_next: true },
    ])
    expect(tiedPitchIndices(ev)).toEqual([0, 2])
  })

  it('returns all indices when event-wide flag is set and no per-pitch overrides', () => {
    const ev = { pitches: [C4, E4, G4], duration: 'quarter' as const, tied_to_next: true }
    expect(tiedPitchIndices(ev)).toEqual([0, 1, 2])
  })

  it('per-pitch false overrides event-wide true (selective release)', () => {
    const ev = {
      pitches: [C4, { ...E4, tied_to_next: false }, G4],
      duration: 'quarter' as const,
      tied_to_next: true,
    }
    expect(tiedPitchIndices(ev)).toEqual([0, 2])
  })
})

describe('withPitchTie / withLaissezVibrer', () => {
  it('withPitchTie returns a new object (immutable)', () => {
    const a = { ...C4 }
    const b = withPitchTie(a, true)
    expect(a.tied_to_next).toBeUndefined()
    expect(b.tied_to_next).toBe(true)
    expect(b).not.toBe(a)
  })

  it('withPitchTie sets false to release a tie', () => {
    const a = { ...C4, tied_to_next: true }
    const b = withPitchTie(a, false)
    expect(b.tied_to_next).toBe(false)
  })

  it('withLaissezVibrer sets lv and does not mutate input', () => {
    const a: Pitch = { ...C4 }
    const b = withLaissezVibrer(a, true)
    expect(a.lv).toBeUndefined()
    expect(b.lv).toBe(true)
    expect(b).not.toBe(a)
  })

  it('withPitchTie preserves step, octave, accidental, lv, enharmonicTie', () => {
    const a: Pitch = {
      step: 'C',
      octave: 4,
      accidental: 'sharp',
      lv: true,
      enharmonicTie: true,
    }
    const b = withPitchTie(a, true)
    expect(b.step).toBe('C')
    expect(b.octave).toBe(4)
    expect(b.accidental).toBe('sharp')
    expect(b.lv).toBe(true)
    expect(b.enharmonicTie).toBe(true)
    expect(b.tied_to_next).toBe(true)
  })

  it('withLaissezVibrer preserves step, octave, accidental, tied_to_next, enharmonicTie', () => {
    const a: Pitch = {
      step: 'C',
      octave: 4,
      accidental: 'sharp',
      tied_to_next: true,
      enharmonicTie: true,
    }
    const b = withLaissezVibrer(a, true)
    expect(b.step).toBe('C')
    expect(b.octave).toBe(4)
    expect(b.accidental).toBe('sharp')
    expect(b.tied_to_next).toBe(true)
    expect(b.enharmonicTie).toBe(true)
    expect(b.lv).toBe(true)
  })
})

describe('PitchSchema accepts new optional fields', () => {
  it('parses pitch with tied_to_next', () => {
    expect(() => PitchSchema.parse({ ...C4, tied_to_next: true })).not.toThrow()
  })

  it('parses pitch with lv', () => {
    expect(() => PitchSchema.parse({ ...C4, lv: true })).not.toThrow()
  })

  it('parses pitch with enharmonicTie', () => {
    expect(() => PitchSchema.parse({ ...C4, enharmonicTie: true })).not.toThrow()
  })

  it('parses legacy pitch with none of the new fields (back-compat)', () => {
    expect(() => PitchSchema.parse(C4)).not.toThrow()
  })

  it('rejects non-boolean values for the new fields', () => {
    expect(() => PitchSchema.parse({ ...C4, tied_to_next: 'yes' })).toThrow()
    expect(() => PitchSchema.parse({ ...C4, lv: 1 })).toThrow()
    expect(() => PitchSchema.parse({ ...C4, enharmonicTie: 'maybe' })).toThrow()
  })
})

describe('Score-level round-trip with per-pitch ties', () => {
  it('validates a chord with selectively-tied pitches inside a real score', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C' as const, octave: 4, tied_to_next: true },
                { step: 'E' as const, octave: 4 },
                { step: 'G' as const, octave: 4, tied_to_next: true },
              ],
              duration: 'half' as const,
            },
            {
              pitches: [C4, E4, G4],
              duration: 'half' as const,
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates a pitch with lv inside a real score (open-ended tie)', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...C4, lv: true }],
              duration: 'whole' as const,
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates a pitch with enharmonicTie', () => {
    // C#4 tied to a respelled Db4 in the next measure — enharmonicTie
    // relaxes the step+octave match check. PR-13 cross-ref validation
    // requires a successor event, so we include one with Db.
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C' as const, octave: 4, accidental: 'sharp' as const, enharmonicTie: true, tied_to_next: true },
              ],
              duration: 'whole' as const,
            },
          ],
        },
        {
          events: [
            {
              pitches: [
                { step: 'D' as const, octave: 4, accidental: 'flat' as const },
              ],
              duration: 'whole' as const,
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates per-pitch ties across multiple measures', () => {
    // Bar 1 ends with a chord [C-tied, E, G] tying only C across the
    // barline; bar 2 starts with [C, E, G].
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [C4, E4, G4], duration: 'half' as const },
            {
              pitches: [{ ...C4, tied_to_next: true }, E4, G4],
              duration: 'half' as const,
            },
          ],
        },
        {
          events: [
            { pitches: [C4, E4, G4], duration: 'whole' as const },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates per-pitch ties across multiple voices (SATB top staff)', () => {
    // PR-13 cross-ref validation requires a target event for each tie.
    // Soprano: C tied across a barline to another C. Alto: E tied to E.
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...C4, tied_to_next: true }],
              duration: 'whole' as const,
            },
          ],
        },
        {
          events: [
            { pitches: [C4], duration: 'whole' as const },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                {
                  pitches: [{ ...E4, tied_to_next: true }],
                  duration: 'whole' as const,
                },
              ],
            },
            {
              events: [
                { pitches: [E4], duration: 'whole' as const },
              ],
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('LEGACY: event-wide tied_to_next still validates (back-compat pin)', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [C4, E4, G4],
              duration: 'half' as const,
              tied_to_next: true,
            },
            {
              pitches: [C4, E4, G4],
              duration: 'half' as const,
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })
})
