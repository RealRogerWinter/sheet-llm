import { describe, it, expect } from 'vitest'
import {
  getMaxVerse,
  getSyllable,
  getSyllableText,
  getVerseNumbers,
  removeSyllable,
  setSyllable,
  syllableHasExtender,
  syllableHasHyphen,
} from '@/lib/music/lyrics'
import { EventSchema, LyricSyllableSchema, type Event } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const makeEvent = (lyrics?: Event['lyrics']): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  lyrics,
})

describe('LyricSyllableSchema', () => {
  it('accepts a minimal syllable', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 1, syllable: 'la' })).not.toThrow()
  })

  it('accepts hyphen and extender flags', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 1, syllable: 'Hel', hyphen: true })).not.toThrow()
    expect(() => LyricSyllableSchema.parse({ verse: 2, syllable: 'A', extender: true })).not.toThrow()
  })

  it('rejects verse < 1 or > 50', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 0, syllable: 'la' })).toThrow()
    expect(() => LyricSyllableSchema.parse({ verse: 51, syllable: 'la' })).toThrow()
  })

  it('rejects negative / NaN / Infinity verse', () => {
    expect(() => LyricSyllableSchema.parse({ verse: -1, syllable: 'la' })).toThrow()
    expect(() => LyricSyllableSchema.parse({ verse: Number.NaN, syllable: 'la' })).toThrow()
    expect(() => LyricSyllableSchema.parse({ verse: Number.POSITIVE_INFINITY, syllable: 'la' })).toThrow()
  })

  it('rejects a non-integer verse (e.g. 1.5)', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 1.5, syllable: 'la' })).toThrow()
  })

  it('rejects an empty syllable (use array omission for silent events)', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 1, syllable: '' })).toThrow()
  })

  it('rejects syllable longer than 40 chars', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 1, syllable: 'x'.repeat(41) })).toThrow()
  })

  it('accepts a 1-char and a 40-char syllable (boundary)', () => {
    expect(() => LyricSyllableSchema.parse({ verse: 1, syllable: 'a' })).not.toThrow()
    expect(() => LyricSyllableSchema.parse({ verse: 1, syllable: 'x'.repeat(40) })).not.toThrow()
  })
})

describe('EventSchema with lyrics field', () => {
  it('accepts an event with a single-verse lyric', () => {
    const ev = makeEvent([{ verse: 1, syllable: 'la' }])
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('accepts an event with multi-verse lyrics', () => {
    const ev = makeEvent([
      { verse: 1, syllable: 'A', hyphen: true },
      { verse: 2, syllable: 'Yet', hyphen: true },
      { verse: 3, syllable: 'Once', hyphen: true },
    ])
    expect(() => EventSchema.parse(ev)).not.toThrow()
  })

  it('rejects more than 50 lyric entries', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ verse: i + 1, syllable: 'x' }))
    expect(() => EventSchema.parse(makeEvent(tooMany))).toThrow()
  })

  it('rejects duplicate verse numbers within a single event', () => {
    const dup = makeEvent([
      { verse: 1, syllable: 'a' },
      { verse: 1, syllable: 'b' },
    ])
    expect(() => EventSchema.parse(dup)).toThrow()
  })

  it('accepts an event with no lyrics (back-compat)', () => {
    expect(() => EventSchema.parse(makeEvent())).not.toThrow()
  })
})

describe('getSyllable / getSyllableText', () => {
  const ev = makeEvent([
    { verse: 1, syllable: 'Hel', hyphen: true },
    { verse: 2, syllable: 'Lord' },
  ])

  it('returns the syllable for a verse', () => {
    expect(getSyllable(ev, 1)?.syllable).toBe('Hel')
    expect(getSyllable(ev, 2)?.syllable).toBe('Lord')
  })

  it('returns undefined when the verse has no syllable', () => {
    expect(getSyllable(ev, 3)).toBeUndefined()
  })

  it('returns undefined when the event has no lyrics', () => {
    expect(getSyllable(makeEvent(), 1)).toBeUndefined()
  })

  it('getSyllableText returns just the text', () => {
    expect(getSyllableText(ev, 1)).toBe('Hel')
    expect(getSyllableText(ev, 3)).toBeUndefined()
  })
})

describe('getVerseNumbers', () => {
  it('returns sorted verse numbers', () => {
    const ev = makeEvent([
      { verse: 3, syllable: 'c' },
      { verse: 1, syllable: 'a' },
      { verse: 2, syllable: 'b' },
    ])
    expect(getVerseNumbers(ev)).toEqual([1, 2, 3])
  })

  it('returns empty array for an event with no lyrics', () => {
    expect(getVerseNumbers(makeEvent())).toEqual([])
  })
})

describe('syllableHasHyphen / syllableHasExtender', () => {
  const ev = makeEvent([
    { verse: 1, syllable: 'Hel', hyphen: true },
    { verse: 2, syllable: 'O', extender: true },
    { verse: 3, syllable: 'la' },
  ])

  it('detects hyphen', () => {
    expect(syllableHasHyphen(ev, 1)).toBe(true)
    expect(syllableHasHyphen(ev, 2)).toBe(false)
    expect(syllableHasHyphen(ev, 3)).toBe(false)
  })

  it('detects extender', () => {
    expect(syllableHasExtender(ev, 2)).toBe(true)
    expect(syllableHasExtender(ev, 1)).toBe(false)
  })

  it('returns false for a verse without a syllable', () => {
    expect(syllableHasHyphen(ev, 99)).toBe(false)
    expect(syllableHasExtender(ev, 99)).toBe(false)
  })
})

describe('setSyllable', () => {
  it('adds a syllable when none exists for the verse', () => {
    const a = makeEvent()
    const b = setSyllable(a, { verse: 1, syllable: 'la' })
    expect(a.lyrics).toBeUndefined()
    expect(b.lyrics).toEqual([{ verse: 1, syllable: 'la' }])
  })

  it('replaces an existing syllable for the same verse', () => {
    const a = makeEvent([{ verse: 1, syllable: 'old' }])
    const b = setSyllable(a, { verse: 1, syllable: 'new', hyphen: true })
    expect(b.lyrics).toEqual([{ verse: 1, syllable: 'new', hyphen: true }])
  })

  it('preserves other verses when replacing one', () => {
    const a = makeEvent([
      { verse: 1, syllable: 'a' },
      { verse: 2, syllable: 'b' },
    ])
    const b = setSyllable(a, { verse: 1, syllable: 'A' })
    expect(b.lyrics).toHaveLength(2)
    expect(getSyllableText(b, 1)).toBe('A')
    expect(getSyllableText(b, 2)).toBe('b')
  })

  it('does not mutate the input', () => {
    const a = makeEvent()
    setSyllable(a, { verse: 1, syllable: 'la' })
    expect(a.lyrics).toBeUndefined()
  })

  it('preserves all other event fields', () => {
    const a: Event = {
      id: 'evtestid12',
      kind: 'note',
      pitches: [{ step: 'C', octave: 4 }],
      duration: 'quarter',
      articulation: 'staccato',
      dynamic: 'mf',
      tied_to_next: true,
    }
    const b = setSyllable(a, { verse: 1, syllable: 'la' })
    expect(b.id).toBe('evtestid12')
    expect(b.kind).toBe('note')
    expect(b.articulation).toBe('staccato')
    expect(b.dynamic).toBe('mf')
    expect(b.tied_to_next).toBe(true)
  })
})

describe('removeSyllable', () => {
  it('removes the syllable for the given verse', () => {
    const a = makeEvent([
      { verse: 1, syllable: 'a' },
      { verse: 2, syllable: 'b' },
    ])
    const b = removeSyllable(a, 1)
    expect(b.lyrics).toEqual([{ verse: 2, syllable: 'b' }])
  })

  it('drops the lyrics field entirely (key absent) when the last syllable is removed', () => {
    const a = makeEvent([{ verse: 1, syllable: 'a' }])
    const b = removeSyllable(a, 1)
    expect(b.lyrics).toBeUndefined()
    // Pin the contract: the property is actually absent, not just undefined.
    expect('lyrics' in b).toBe(false)
  })

  it('no-op when the verse has no syllable', () => {
    const a = makeEvent([{ verse: 1, syllable: 'a' }])
    const b = removeSyllable(a, 99)
    expect(b.lyrics).toEqual([{ verse: 1, syllable: 'a' }])
  })

  it('no-op (and no crash) when the event has no lyrics', () => {
    const a = makeEvent()
    expect(removeSyllable(a, 1).lyrics).toBeUndefined()
  })

  it('does not mutate the input', () => {
    const a = makeEvent([{ verse: 1, syllable: 'a' }])
    removeSyllable(a, 1)
    expect(a.lyrics).toEqual([{ verse: 1, syllable: 'a' }])
  })
})

describe('getMaxVerse', () => {
  const events = (lyrics?: Event['lyrics']) => [{ events: [makeEvent(lyrics)] }]

  it('returns 0 when no event has lyrics', () => {
    expect(
      getMaxVerse({
        key: 'C',
        meter: '4/4',
        measures: events(),
      } as never),
    ).toBe(0)
  })

  it('returns the highest verse across the primary staff', () => {
    expect(
      getMaxVerse({
        key: 'C',
        meter: '4/4',
        measures: events([
          { verse: 1, syllable: 'a' },
          { verse: 3, syllable: 'c' },
        ]),
      } as never),
    ).toBe(3)
  })

  it('honors extraVoices on the primary staff', () => {
    expect(
      getMaxVerse({
        key: 'C',
        meter: '4/4',
        measures: events([{ verse: 1, syllable: 'a' }]),
        extraVoices: [
          { measures: events([{ verse: 5, syllable: 'e' }]) },
        ],
      } as never),
    ).toBe(5)
  })

  it('honors secondStaff and its extraVoices', () => {
    expect(
      getMaxVerse({
        key: 'C',
        meter: '4/4',
        measures: events([{ verse: 1, syllable: 'a' }]),
        secondStaff: {
          clef: 'bass',
          measures: events([{ verse: 2, syllable: 'b' }]),
          extraVoices: [
            { measures: events([{ verse: 7, syllable: 'g' }]) },
          ],
        },
      } as never),
    ).toBe(7)
  })
})

describe('full-score round-trip with lyrics', () => {
  it('validates a single-verse hymn-style fragment', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C' as const, octave: 4 }],
              duration: 'quarter' as const,
              lyrics: [{ verse: 1, syllable: 'A', hyphen: true }],
            },
            {
              pitches: [{ step: 'D' as const, octave: 4 }],
              duration: 'quarter' as const,
              lyrics: [{ verse: 1, syllable: 'might' }],
            },
            {
              pitches: [{ step: 'E' as const, octave: 4 }],
              duration: 'quarter' as const,
              lyrics: [{ verse: 1, syllable: 'y', hyphen: true }],
            },
            {
              pitches: [{ step: 'F' as const, octave: 4 }],
              duration: 'quarter' as const,
              lyrics: [{ verse: 1, syllable: 'For-tress' }],
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })

  it('validates SATB divisi text: voice 0 and voice 1 sing different syllables on the same beat', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C' as const, octave: 5 }],
              duration: 'whole' as const,
              lyrics: [{ verse: 1, syllable: 'Christ-mas' }],
            },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'E' as const, octave: 4 }],
                  duration: 'whole' as const,
                  lyrics: [{ verse: 1, syllable: 'Glo-ri-a' }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(() => validateScore(score)).not.toThrow()
  })
})
