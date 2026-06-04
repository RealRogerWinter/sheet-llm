import { describe, it, expect } from 'vitest'
import { PitchSchema, ScoreSchema, type Score } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

/**
 * Regression: the model emits a COMBINED note name ("Bb", "F#") in the
 * `step` field instead of a bare letter + separate `accidental`. Because
 * render_score is validated against ScoreSchema at the provider layer,
 * one such pitch threw ProviderSchemaError and killed a whole generation
 * (a Bbm grand-staff piece — 5 flats — failed on every note). PitchSchema
 * now normalizes the combined form at the schema boundary.
 */
describe('PitchSchema combined-accidental normalization', () => {
  it('splits "Bb" into step B + accidental flat', () => {
    expect(PitchSchema.parse({ step: 'Bb', octave: 4 })).toEqual({
      step: 'B',
      octave: 4,
      accidental: 'flat',
    })
  })

  it('splits "F#" into step F + accidental sharp', () => {
    expect(PitchSchema.parse({ step: 'F#', octave: 5 })).toEqual({
      step: 'F',
      octave: 5,
      accidental: 'sharp',
    })
  })

  it('handles double accidentals ("Ebb" -> dblflat, "Fx" -> dblsharp)', () => {
    expect(PitchSchema.parse({ step: 'Ebb', octave: 3 })).toMatchObject({
      step: 'E',
      accidental: 'dblflat',
    })
    expect(PitchSchema.parse({ step: 'Fx', octave: 3 })).toMatchObject({
      step: 'F',
      accidental: 'dblsharp',
    })
  })

  it('handles enharmonic spellings the model favors in flat keys (Cb, B#)', () => {
    expect(PitchSchema.parse({ step: 'Cb', octave: 5 })).toMatchObject({ step: 'C', accidental: 'flat' })
    expect(PitchSchema.parse({ step: 'B#', octave: 3 })).toMatchObject({ step: 'B', accidental: 'sharp' })
  })

  it('rescues a lowercase bare letter', () => {
    expect(PitchSchema.parse({ step: 'c', octave: 4 })).toMatchObject({ step: 'C' })
  })

  it('leaves a canonical step untouched and adds no accidental key', () => {
    const parsed = PitchSchema.parse({ step: 'C', octave: 4 })
    expect(parsed).toEqual({ step: 'C', octave: 4 })
    expect('accidental' in parsed).toBe(false)
  })

  it('leaves a rest untouched', () => {
    expect(PitchSchema.parse({ step: 'rest', octave: 4 })).toEqual({ step: 'rest', octave: 4 })
  })

  it('preserves a correct already-split pitch', () => {
    expect(PitchSchema.parse({ step: 'B', octave: 4, accidental: 'flat' })).toEqual({
      step: 'B',
      octave: 4,
      accidental: 'flat',
    })
  })

  it('lets the combined note name win over a contradictory accidental field', () => {
    // "F#" + accidental:"flat" is internally inconsistent; the note NAME
    // the model wrote is the clearer intent, so sharp wins.
    expect(PitchSchema.parse({ step: 'F#', octave: 4, accidental: 'flat' })).toMatchObject({
      step: 'F',
      accidental: 'sharp',
    })
  })

  it('still rejects genuine garbage (step "H")', () => {
    expect(PitchSchema.safeParse({ step: 'H', octave: 4 }).success).toBe(false)
  })
})

describe('ScoreSchema normalizes combined pitches end-to-end (the Bbm failure)', () => {
  it('parses a Bbm score whose notes use combined steps, then passes validateScore', () => {
    // Mirrors the real failure: a Bb-minor piece where the model wrote
    // "Bb"/"Db"/"Ab" as steps. Pre-fix this threw at the ScoreSchema parse.
    const raw = {
      title: 'Bbm test',
      key: 'Bbm',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'Bb', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'Db', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'Ab', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    const parsed = ScoreSchema.parse(raw)
    const pitches = parsed.measures[0].events.map((e) => e.pitches[0])
    expect(pitches).toEqual([
      { step: 'B', octave: 3, accidental: 'flat' },
      { step: 'D', octave: 4, accidental: 'flat' },
      { step: 'F', octave: 4 },
      { step: 'A', octave: 4, accidental: 'flat' },
    ])
    // The normalized score is structurally valid.
    expect(() => validateScore(parsed as Score)).not.toThrow()
  })

  it('normalizes combined steps inside chords and the second staff', () => {
    const raw = {
      title: 'Grand staff',
      key: 'Db',
      meter: '4/4',
      clef: 'treble',
      measures: [
        {
          events: [
            { pitches: [{ step: 'Db', octave: 4 }, { step: 'F', octave: 4 }, { step: 'Ab', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'Db', octave: 2 }], duration: 'whole' }] },
        ],
      },
    }
    const parsed = ScoreSchema.parse(raw)
    expect(parsed.measures[0].events[0].pitches).toEqual([
      { step: 'D', octave: 4, accidental: 'flat' },
      { step: 'F', octave: 4 },
      { step: 'A', octave: 4, accidental: 'flat' },
    ])
    expect(parsed.secondStaff?.measures[0].events[0].pitches[0]).toEqual({
      step: 'D',
      octave: 2,
      accidental: 'flat',
    })
  })
})
