import { describe, it, expect } from 'vitest'
import { EventSchema, type Event } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const makeEvent = (extra: Partial<Event> = {}): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  ...extra,
})

describe('Event.tremolo', () => {
  it('accepts slashes 1-5 with measured optional', () => {
    for (const slashes of [1, 2, 3, 4, 5] as const) {
      expect(() => EventSchema.parse(makeEvent({ tremolo: { slashes } }))).not.toThrow()
    }
  })

  it('accepts measured: true', () => {
    expect(() =>
      EventSchema.parse(makeEvent({ tremolo: { slashes: 3, measured: true } })),
    ).not.toThrow()
  })

  it('accepts measured: false (unmeasured tremolo / bowed string)', () => {
    expect(() =>
      EventSchema.parse(makeEvent({ tremolo: { slashes: 3, measured: false } })),
    ).not.toThrow()
  })

  it('rejects slashes 0 or 6', () => {
    expect(() => EventSchema.parse(makeEvent({ tremolo: { slashes: 0 as never } }))).toThrow()
    expect(() => EventSchema.parse(makeEvent({ tremolo: { slashes: 6 as never } }))).toThrow()
  })

  it('rejects non-numeric slashes', () => {
    expect(() =>
      EventSchema.parse(makeEvent({ tremolo: { slashes: 'lots' as never } })),
    ).toThrow()
  })
})

describe('Event.bowing', () => {
  it('accepts up and down', () => {
    expect(() => EventSchema.parse(makeEvent({ bowing: 'up' }))).not.toThrow()
    expect(() => EventSchema.parse(makeEvent({ bowing: 'down' }))).not.toThrow()
  })

  it('rejects other values', () => {
    expect(() => EventSchema.parse(makeEvent({ bowing: 'left' as never }))).toThrow()
  })

  it('is optional (back-compat)', () => {
    expect(() => EventSchema.parse(makeEvent())).not.toThrow()
  })
})

describe('Event.jazzInflection', () => {
  it('accepts the 5 canonical inflections', () => {
    for (const inflection of ['fall', 'doit', 'scoop', 'plop', 'ghost'] as const) {
      expect(() => EventSchema.parse(makeEvent({ jazzInflection: inflection }))).not.toThrow()
    }
  })

  it('rejects unknown inflections', () => {
    expect(() =>
      EventSchema.parse(makeEvent({ jazzInflection: 'wail' as never })),
    ).toThrow()
  })
})

describe('combined per-note markings on one event', () => {
  it('validates a kitchen-sink event (tremolo + bowing + jazz inflection + articulation + dynamic)', () => {
    const ev = makeEvent({
      tremolo: { slashes: 2, measured: true },
      bowing: 'down',
      jazzInflection: 'ghost',
      articulations: ['staccato', 'accent'],
      dynamic: 'mf',
      fermata: 'standard',
    })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })
})

describe('Full-score round-trip with new per-note fields', () => {
  it('validates a score with tremolo + bowing + jazz inflection', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            makeEvent({ tremolo: { slashes: 3 } }),
            makeEvent({ pitches: [{ step: 'D', octave: 4 }], bowing: 'up' }),
            makeEvent({ pitches: [{ step: 'E', octave: 4 }], jazzInflection: 'fall' }),
            makeEvent({
              pitches: [{ step: 'F', octave: 4 }],
              tremolo: { slashes: 1, measured: false },
              bowing: 'down',
            }),
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('back-compat: legacy score without the new fields still validates', () => {
    expect(() =>
      validateScore({
        key: 'C',
        meter: '4/4',
        measures: [
          {
            events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          },
        ],
      }),
    ).not.toThrow()
  })
})
