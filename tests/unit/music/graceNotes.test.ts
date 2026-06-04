import { describe, it, expect } from 'vitest'
import {
  EventSchema,
  GraceNoteSchema,
  GraceDurationSchema,
  type Event,
  type GraceNote,
} from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const makeEvent = (extra: Partial<Event> = {}): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  ...extra,
})

describe('GraceDurationSchema', () => {
  it('accepts eighth / sixteenth / 32nd', () => {
    for (const d of ['eighth', 'sixteenth', '32nd']) {
      expect(() => GraceDurationSchema.parse(d)).not.toThrow()
    }
  })

  it('rejects longer durations (half, quarter) and dotted variants', () => {
    expect(() => GraceDurationSchema.parse('half')).toThrow()
    expect(() => GraceDurationSchema.parse('quarter')).toThrow()
    expect(() => GraceDurationSchema.parse('whole')).toThrow()
    expect(() => GraceDurationSchema.parse('dotted-eighth')).toThrow()
  })
})

describe('GraceNoteSchema', () => {
  it('validates a single-pitch eighth grace note', () => {
    const g: GraceNote = {
      pitches: [{ step: 'D', octave: 5 }],
      duration: 'eighth',
    }
    expect(() => GraceNoteSchema.parse(g)).not.toThrow()
  })

  it('validates a slashed acciaccatura', () => {
    const g: GraceNote = {
      pitches: [{ step: 'D', octave: 5 }],
      duration: 'sixteenth',
      slashed: true,
    }
    expect(() => GraceNoteSchema.parse(g)).not.toThrow()
  })

  it('preserves slashed=false verbatim (no coercion to undefined)', () => {
    // Locks the round-trip invariant against the M5 conditional-spread
    // class of bug: a future PR that normalizes graceNotes must not
    // drop slashed:false back to undefined.
    const parsed = GraceNoteSchema.parse({
      pitches: [{ step: 'D', octave: 5 }],
      duration: 'eighth',
      slashed: false,
    })
    expect(parsed.slashed).toBe(false)
  })

  it('validates a grace chord (multiple pitches at one moment)', () => {
    const g: GraceNote = {
      pitches: [
        { step: 'C', octave: 5 },
        { step: 'E', octave: 5 },
        { step: 'G', octave: 5 },
      ],
      duration: 'eighth',
    }
    expect(() => GraceNoteSchema.parse(g)).not.toThrow()
  })

  it('rejects an empty pitches array', () => {
    expect(() =>
      GraceNoteSchema.parse({ pitches: [], duration: 'eighth' }),
    ).toThrow()
  })

  it('rejects rest pitches (incoherent for grace)', () => {
    expect(() =>
      GraceNoteSchema.parse({
        pitches: [{ step: 'rest', octave: 4 }],
        duration: 'eighth',
      }),
    ).toThrow(/cannot be rests/)
  })

  it('rejects a chord with one rest mixed in', () => {
    expect(() =>
      GraceNoteSchema.parse({
        pitches: [
          { step: 'C', octave: 5 },
          { step: 'rest', octave: 4 },
        ],
        duration: 'eighth',
      }),
    ).toThrow(/cannot be rests/)
  })

  it('rejects more than 6 pitches in a single grace chord', () => {
    expect(() =>
      GraceNoteSchema.parse({
        pitches: [
          { step: 'C', octave: 5 },
          { step: 'D', octave: 5 },
          { step: 'E', octave: 5 },
          { step: 'F', octave: 5 },
          { step: 'G', octave: 5 },
          { step: 'A', octave: 5 },
          { step: 'B', octave: 5 },
        ],
        duration: 'eighth',
      }),
    ).toThrow()
  })
})

describe('Event with graceNotes', () => {
  it('accepts a single before-grace appoggiatura', () => {
    const ev = makeEvent({
      graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
    })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('accepts a beamed grace run (3-note approach to principal)', () => {
    const ev = makeEvent({
      graceNotes: [
        { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'sixteenth' },
      ],
    })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('accepts a mix of grace chord + single grace', () => {
    const ev = makeEvent({
      graceNotes: [
        {
          pitches: [
            { step: 'C', octave: 5 },
            { step: 'E', octave: 5 },
          ],
          duration: 'eighth',
        },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', slashed: true },
      ],
    })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('graceNotes is optional', () => {
    const ev = makeEvent()
    expect(() => EventSchema.parse(ev)).not.toThrow()
    expect(EventSchema.parse(ev).graceNotes).toBeUndefined()
  })

  it('accepts an empty graceNotes array (semantically equivalent to absent — renderer falls back to legacy ornament=grace if set)', () => {
    // Lock the M7-PR-4 renderer contract documented in EventSchema's
    // graceNotes docstring: "when this array is present + non-empty,
    // the renderer emits structured glyphs. When absent or empty,
    // ornament: 'grace' continues to render its default." An empty
    // array must be accepted at schema level so callers don't have to
    // delete the field to clear it.
    const ev = makeEvent({ graceNotes: [] })
    expect(() => EventSchema.parse(ev)).not.toThrow()
    expect(EventSchema.parse(ev).graceNotes).toEqual([])
  })

  it('graceNotes can coexist with the legacy ornament="grace" during rollout', () => {
    // Both representations valid simultaneously — the renderer
    // (M7-PR-4) prefers structured graceNotes when present.
    const ev = makeEvent({
      ornament: 'grace',
      graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
    })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('rejects more than 8 grace moments in one event', () => {
    const ev = makeEvent({
      graceNotes: Array.from({ length: 9 }, () => ({
        pitches: [{ step: 'C', octave: 5 }],
        duration: 'sixteenth' as const,
      })),
    })
    expect(() => EventSchema.parse(ev)).toThrow()
  })
})

describe('Full-score round-trip with graceNotes', () => {
  it('validates a score with structured grace notes via validateScore', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            makeEvent({
              graceNotes: [
                { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth', slashed: true },
              ],
            }),
            makeEvent({ pitches: [{ step: 'D', octave: 4 }] }),
            makeEvent({
              pitches: [{ step: 'E', octave: 4 }],
              graceNotes: [
                {
                  pitches: [
                    { step: 'F', octave: 4 },
                    { step: 'A', octave: 4 },
                  ],
                  duration: 'sixteenth',
                },
              ],
            }),
            makeEvent({ pitches: [{ step: 'F', octave: 4 }] }),
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('round-trip preserves graceNotes content', () => {
    const original = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            makeEvent({
              graceNotes: [
                {
                  pitches: [{ step: 'D', octave: 5 }],
                  duration: 'eighth',
                  slashed: true,
                },
                {
                  pitches: [
                    { step: 'C', octave: 5 },
                    { step: 'E', octave: 5 },
                  ],
                  duration: 'sixteenth',
                },
              ],
            }),
            makeEvent({ pitches: [{ step: 'D', octave: 4 }] }),
            makeEvent({ pitches: [{ step: 'E', octave: 4 }] }),
            makeEvent({ pitches: [{ step: 'F', octave: 4 }] }),
          ],
        },
      ],
    }
    const validated = validateScore(original)
    const first = validated.measures[0].events[0]
    expect(first.graceNotes).toEqual(original.measures[0].events[0].graceNotes)
    // Full-score equality catches any future normalization that strips
    // or rewrites graceNotes anywhere in the tree (not just events[0]).
    expect(validated).toEqual(original)
  })
})
