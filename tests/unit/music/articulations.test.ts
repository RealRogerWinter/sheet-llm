import { describe, it, expect } from 'vitest'
import {
  ArticulationStackingError,
  getArticulations,
  hasArticulation,
  normalizeArticulations,
  withArticulation,
  withoutArticulation,
} from '@/lib/music/articulations'
import { ArticulationSchema, EventSchema, type Event } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const makeEvent = (extra: Partial<Event> = {}): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  ...extra,
})

describe('ArticulationSchema', () => {
  it('includes portato (compound glyph)', () => {
    expect(() => ArticulationSchema.parse('portato')).not.toThrow()
  })
  it('preserves the existing values', () => {
    for (const a of ['staccato', 'accent', 'tenuto', 'marcato', 'none']) {
      expect(() => ArticulationSchema.parse(a)).not.toThrow()
    }
  })
})

describe('getArticulations / hasArticulation', () => {
  it('returns empty array when no articulation set', () => {
    expect(getArticulations(makeEvent())).toEqual([])
  })

  it('honors the legacy singular field', () => {
    expect(getArticulations(makeEvent({ articulation: 'staccato' }))).toEqual(['staccato'])
  })

  it('treats legacy "none" as empty', () => {
    expect(getArticulations(makeEvent({ articulation: 'none' }))).toEqual([])
  })

  it('honors the new plural field (precedence over singular)', () => {
    const ev = makeEvent({ articulations: ['staccato', 'accent'], articulation: 'tenuto' })
    expect(getArticulations(ev)).toEqual(['staccato', 'accent'])
  })

  it('hasArticulation finds applied glyphs', () => {
    const ev = makeEvent({ articulations: ['staccato', 'accent'] })
    expect(hasArticulation(ev, 'staccato')).toBe(true)
    expect(hasArticulation(ev, 'tenuto')).toBe(false)
  })
})

describe('normalizeArticulations', () => {
  it('sorts in canonical stacking order: staccato → portato → tenuto → accent → marcato', () => {
    // Excludes marcato+accent (rejected). staccato+tenuto auto-coerces
    // to portato; that's tested separately.
    expect(normalizeArticulations(['accent', 'portato'])).toEqual(['portato', 'accent'])
    expect(normalizeArticulations(['marcato', 'tenuto', 'portato'])).toEqual([
      'portato',
      'tenuto',
      'marcato',
    ])
  })

  it('deduplicates repeated entries', () => {
    expect(normalizeArticulations(['staccato', 'staccato', 'accent'])).toEqual([
      'staccato',
      'accent',
    ])
  })

  it('coerces staccato+tenuto → portato (single compound glyph)', () => {
    expect(normalizeArticulations(['staccato', 'tenuto'])).toEqual(['portato'])
  })

  it('staccato+tenuto+accent → portato+accent (preserves accent on top)', () => {
    expect(normalizeArticulations(['staccato', 'tenuto', 'accent'])).toEqual(['portato', 'accent'])
  })

  it('leaves an existing portato alone if also given staccato or tenuto', () => {
    expect(normalizeArticulations(['portato', 'staccato'])).toEqual(['staccato', 'portato'])
    expect(normalizeArticulations(['portato', 'tenuto'])).toEqual(['portato', 'tenuto'])
  })

  it('rejects marcato + accent as incoherent (Gould p.116)', () => {
    expect(() => normalizeArticulations(['marcato', 'accent'])).toThrow(ArticulationStackingError)
  })

  it("filters 'none' entries", () => {
    expect(normalizeArticulations(['staccato', 'none'])).toEqual(['staccato'])
  })
})

describe('withArticulation / withoutArticulation', () => {
  it('adds an articulation to an empty event', () => {
    const a = makeEvent()
    const b = withArticulation(a, 'staccato')
    expect(b.articulations).toEqual(['staccato'])
    expect(a.articulations).toBeUndefined()
  })

  it('does not mutate the input', () => {
    const a = makeEvent({ articulations: ['staccato'] })
    withArticulation(a, 'accent')
    expect(a.articulations).toEqual(['staccato'])
  })

  it('upgrades a legacy singular field into the new plural field', () => {
    const a = makeEvent({ articulation: 'tenuto' })
    const b = withArticulation(a, 'staccato')
    expect(b.articulation).toBeUndefined()
    expect(b.articulations).toEqual(['portato']) // staccato + tenuto coerced
  })

  it('throws when marcato + accent collide', () => {
    const a = makeEvent({ articulations: ['marcato'] })
    expect(() => withArticulation(a, 'accent')).toThrow(ArticulationStackingError)
  })

  it("withoutArticulation drops the field when no articulations remain", () => {
    const a = makeEvent({ articulations: ['staccato'] })
    const b = withoutArticulation(a, 'staccato')
    expect('articulations' in b).toBe(false)
  })

  it("withoutArticulation no-ops on missing articulation", () => {
    const a = makeEvent({ articulations: ['staccato'] })
    const b = withoutArticulation(a, 'accent')
    expect(b.articulations).toEqual(['staccato'])
  })
})

describe('EventSchema accepts the new fields', () => {
  it('accepts an event with stacked articulations', () => {
    expect(() =>
      EventSchema.parse(makeEvent({ articulations: ['staccato', 'accent'] })),
    ).not.toThrow()
  })

  it('accepts an event with fermata + breath + caesura', () => {
    expect(() =>
      EventSchema.parse(makeEvent({ fermata: 'long', breathMark: true, caesura: true })),
    ).not.toThrow()
  })

  it('rejects unknown fermata kinds', () => {
    expect(() =>
      EventSchema.parse({
        ...makeEvent(),
        fermata: 'gigantic',
      }),
    ).toThrow()
  })

  it('accepts the new dynamic enum entries (n, sfz, sffz, etc.)', () => {
    for (const d of ['n', 'sfz', 'sffz', 'pppp', 'ffff']) {
      expect(() => EventSchema.parse(makeEvent({ dynamic: d as never }))).not.toThrow()
    }
  })
})

describe('full-Score round-trip with PR-7 fields', () => {
  it('validates a score with fermata, breath mark, and stacked articulations', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            makeEvent({
              articulations: ['staccato', 'accent'],
              dynamic: 'mf' as const,
            }),
            makeEvent({ pitches: [{ step: 'D', octave: 4 }] }),
            makeEvent({
              pitches: [{ step: 'E', octave: 4 }],
              fermata: 'long',
              breathMark: true,
            }),
            makeEvent({ pitches: [{ step: 'F', octave: 4 }] }),
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates a score with a barline fermata (general pause)', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [makeEvent({ duration: 'whole' })],
          barlineFermata: 'standard' as const,
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })
})
