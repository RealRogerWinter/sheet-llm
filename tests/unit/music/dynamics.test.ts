import { describe, it, expect } from 'vitest'
import {
  formatDynamic,
  getDynamicBase,
  getDynamicMarking,
  parseDynamic,
} from '@/lib/music/dynamics'
import { DynamicMarkingSchema, EventSchema, type Event } from '@/lib/music/types'

const makeEvent = (extra: Partial<Event> = {}): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  ...extra,
})

describe('DynamicMarkingSchema', () => {
  it('accepts a minimal marking', () => {
    expect(() => DynamicMarkingSchema.parse({ base: 'p' })).not.toThrow()
  })
  it('accepts compound forms', () => {
    expect(() =>
      DynamicMarkingSchema.parse({ base: 'p', prefix: 'sub.', suffix: 'espressivo' }),
    ).not.toThrow()
    expect(() =>
      DynamicMarkingSchema.parse({ base: 'f', prefix: 'poco' }),
    ).not.toThrow()
  })
  it('rejects an unknown base', () => {
    expect(() => DynamicMarkingSchema.parse({ base: 'medium' })).toThrow()
  })
  it('rejects an unknown prefix', () => {
    expect(() => DynamicMarkingSchema.parse({ base: 'p', prefix: 'sometimes' })).toThrow()
  })
})

describe('getDynamicMarking / getDynamicBase', () => {
  it('returns undefined when no dynamic is set', () => {
    expect(getDynamicMarking(makeEvent())).toBeUndefined()
    expect(getDynamicBase(makeEvent())).toBeUndefined()
  })
  it('treats legacy dynamic:"none" as no dynamic', () => {
    expect(getDynamicMarking(makeEvent({ dynamic: 'none' }))).toBeUndefined()
  })
  it('returns a wrapped legacy enum when only `dynamic` is set', () => {
    expect(getDynamicMarking(makeEvent({ dynamic: 'mf' }))).toEqual({ base: 'mf' })
    expect(getDynamicBase(makeEvent({ dynamic: 'mf' }))).toBe('mf')
  })
  it('returns the structured marking when present', () => {
    const ev = makeEvent({
      dynamic: 'mf', // legacy field also set; structured wins
      dynamic_structured: { base: 'p', prefix: 'sub.', suffix: 'espressivo' },
    })
    expect(getDynamicMarking(ev)).toEqual({ base: 'p', prefix: 'sub.', suffix: 'espressivo' })
    expect(getDynamicBase(ev)).toBe('p')
  })
})

describe('formatDynamic', () => {
  it('formats a bare base', () => {
    expect(formatDynamic({ base: 'mf' })).toBe('mf')
  })
  it('formats prefix + base', () => {
    expect(formatDynamic({ base: 'p', prefix: 'sub.' })).toBe('sub. p')
  })
  it('formats base + suffix', () => {
    expect(formatDynamic({ base: 'f', suffix: 'marcato' })).toBe('f marcato')
  })
  it('formats compound prefix + base + suffix', () => {
    expect(formatDynamic({ base: 'p', prefix: 'poco', suffix: 'espressivo' })).toBe(
      'poco p espressivo',
    )
  })
})

describe('parseDynamic', () => {
  it('parses a bare base', () => {
    expect(parseDynamic('mf')).toEqual({ base: 'mf' })
  })
  it('parses prefix + base', () => {
    expect(parseDynamic('sub. p')).toEqual({ base: 'p', prefix: 'sub.' })
    expect(parseDynamic('poco f')).toEqual({ base: 'f', prefix: 'poco' })
  })
  it('parses base + suffix', () => {
    expect(parseDynamic('f marcato')).toEqual({ base: 'f', suffix: 'marcato' })
  })
  it('parses compound prefix + base + suffix', () => {
    expect(parseDynamic('sub. p espressivo')).toEqual({
      base: 'p',
      prefix: 'sub.',
      suffix: 'espressivo',
    })
  })
  it('parses single-glyph compounds (sfz, sffz)', () => {
    expect(parseDynamic('sfz')).toEqual({ base: 'sfz' })
    expect(parseDynamic('sffz')).toEqual({ base: 'sffz' })
  })
  it('parses niente (n)', () => {
    expect(parseDynamic('n')).toEqual({ base: 'n' })
  })
  it('returns null for unparseable input', () => {
    expect(parseDynamic('')).toBeNull()
    expect(parseDynamic('xyzzy')).toBeNull()
    expect(parseDynamic('sub.')).toBeNull() // prefix alone, no base
  })
})

describe('round-trip parse → format', () => {
  it('round-trips canonical compound forms', () => {
    const inputs = [
      'p',
      'mf',
      'ffff',
      'sub. p',
      'poco f',
      'p marcato',
      'sub. p espressivo',
      'sfz',
      'sffz',
      'fp',
      'n',
    ]
    for (const s of inputs) {
      const parsed = parseDynamic(s)
      expect(parsed).not.toBeNull()
      expect(formatDynamic(parsed!)).toBe(s)
    }
  })
})

describe('EventSchema accepts dynamic_structured', () => {
  it('accepts an event with structured compound dynamic', () => {
    expect(() =>
      EventSchema.parse(
        makeEvent({ dynamic_structured: { base: 'p', prefix: 'sub.', suffix: 'espressivo' } }),
      ),
    ).not.toThrow()
  })
  it('accepts both legacy + structured (structured takes precedence in getDynamic*)', () => {
    expect(() =>
      EventSchema.parse(
        makeEvent({ dynamic: 'mf', dynamic_structured: { base: 'p', prefix: 'sub.' } }),
      ),
    ).not.toThrow()
  })
})
