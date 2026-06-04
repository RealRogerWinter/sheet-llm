import { describe, it, expect } from 'vitest'
import { EventSchema, OrnamentSchema, TrillUpperPitchSchema, type Event } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const makeEvent = (extra: Partial<Event> = {}): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  ...extra,
})

describe('OrnamentSchema — Baroque vocabulary additions', () => {
  it('accepts pralltriller (upper mordent with stroke)', () => {
    expect(() => OrnamentSchema.parse('pralltriller')).not.toThrow()
  })
  it('accepts upper-mordent and lower-mordent', () => {
    expect(() => OrnamentSchema.parse('upper-mordent')).not.toThrow()
    expect(() => OrnamentSchema.parse('lower-mordent')).not.toThrow()
  })
  it('accepts schneller (older inverted-mordent variant)', () => {
    expect(() => OrnamentSchema.parse('schneller')).not.toThrow()
  })
  it('accepts inverted-turn and delayed-turn', () => {
    expect(() => OrnamentSchema.parse('inverted-turn')).not.toThrow()
    expect(() => OrnamentSchema.parse('delayed-turn')).not.toThrow()
  })
  it('accepts slide (Schleifer)', () => {
    expect(() => OrnamentSchema.parse('slide')).not.toThrow()
  })
  it('accepts arpeggio variants', () => {
    expect(() => OrnamentSchema.parse('arpeggio-up')).not.toThrow()
    expect(() => OrnamentSchema.parse('arpeggio-down')).not.toThrow()
    expect(() => OrnamentSchema.parse('non-arpeggio')).not.toThrow()
  })
  it('back-compat: existing values still accepted', () => {
    for (const o of ['trill', 'mordent', 'turn', 'grace', 'none']) {
      expect(() => OrnamentSchema.parse(o)).not.toThrow()
    }
  })
  it('rejects unknown ornaments', () => {
    expect(() => OrnamentSchema.parse('vibrato')).toThrow()
    expect(() => OrnamentSchema.parse('flourish')).toThrow()
  })
})

describe('TrillUpperPitchSchema', () => {
  it('accepts the 5 accidental kinds', () => {
    for (const a of ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat']) {
      expect(() => TrillUpperPitchSchema.parse(a)).not.toThrow()
    }
  })
  it('rejects unknown values', () => {
    expect(() => TrillUpperPitchSchema.parse('quartersharp')).toThrow()
  })
})

describe('Event with trill + trillUpperPitch', () => {
  it("validates 'tr♯' style: trill with sharp upper auxiliary", () => {
    const ev = makeEvent({ ornament: 'trill', trillUpperPitch: 'sharp' })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it("validates 'tr♮' style: trill with natural upper auxiliary (overrides key sig)", () => {
    const ev = makeEvent({ ornament: 'trill', trillUpperPitch: 'natural' })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('trillUpperPitch is optional on plain trill', () => {
    const ev = makeEvent({ ornament: 'trill' })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('trillUpperPitch is independent of trill — schema permits it on any event', () => {
    // Schema-level invariant of "only meaningful with trill-family
    // ornaments" is deferred to PR-13. For now the field is purely
    // additive and may be set on any event.
    const ev = makeEvent({ ornament: 'mordent', trillUpperPitch: 'sharp' })
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })
})

describe('Full-score round-trip with Baroque ornaments', () => {
  it('validates a score with multiple Baroque ornaments', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            makeEvent({ ornament: 'pralltriller' }),
            makeEvent({ pitches: [{ step: 'D', octave: 4 }], ornament: 'upper-mordent' }),
            makeEvent({ pitches: [{ step: 'E', octave: 4 }], ornament: 'inverted-turn' }),
            makeEvent({ pitches: [{ step: 'F', octave: 4 }], ornament: 'slide' }),
          ],
        },
        {
          events: [
            makeEvent({
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'whole',
              ornament: 'arpeggio-down',
            }),
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates a Bach-style trill with sharpened upper neighbor', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            makeEvent({ duration: 'whole', ornament: 'trill', trillUpperPitch: 'sharp' }),
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })
})
