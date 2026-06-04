import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import type { Score } from '@/lib/music/types'

function buildScore(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ],
      },
    ],
  }
}

describe('setLyric', () => {
  it('attaches a verse-1 syllable to an event and validates', () => {
    const next = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'A',
    })
    const ev = next.measures[0].events[0]
    expect(ev.lyrics).toEqual([{ verse: 1, syllable: 'A' }])
    expect(() => validateScore(next)).not.toThrow()
  })

  it('attaches multiple verses on the same event', () => {
    let sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'first',
    })
    sc = applyOperation(sc, {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 2,
      syllable: 'second',
    })
    const ev = sc.measures[0].events[0]
    expect(ev.lyrics).toHaveLength(2)
    expect(ev.lyrics?.find((s) => s.verse === 1)?.syllable).toBe('first')
    expect(ev.lyrics?.find((s) => s.verse === 2)?.syllable).toBe('second')
  })

  it('REPLACES an existing same-verse syllable', () => {
    let sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'old',
    })
    sc = applyOperation(sc, {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'new',
    })
    const ev = sc.measures[0].events[0]
    expect(ev.lyrics).toHaveLength(1)
    expect(ev.lyrics?.[0].syllable).toBe('new')
  })

  it('persists hyphen:true and extender:true', () => {
    const next = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'glo',
      hyphen: true,
    })
    expect(next.measures[0].events[0].lyrics?.[0].hyphen).toBe(true)

    const next2 = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'A',
      extender: true,
    })
    expect(next2.measures[0].events[0].lyrics?.[0].extender).toBe(true)
  })

  it('omits hyphen/extender when not set (no false-positive flags)', () => {
    const next = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'A',
    })
    const syl = next.measures[0].events[0].lyrics?.[0]
    expect(syl?.hyphen).toBeUndefined()
    expect(syl?.extender).toBeUndefined()
  })

  it('rejects verse < 1', () => {
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 0,
        syllable: 'A',
      }),
    ).toThrow(/verse .* out of range/)
  })

  it('rejects verse > 50', () => {
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 51,
        syllable: 'A',
      }),
    ).toThrow(/verse .* out of range/)
  })

  it('rejects non-integer verse', () => {
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 1.5,
        syllable: 'A',
      }),
    ).toThrow(/verse .* out of range/)
  })

  it('rejects empty syllable', () => {
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 1,
        syllable: '',
      }),
    ).toThrow(/syllable length .* out of range/)
  })

  it('rejects syllable > 40 chars', () => {
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 1,
        syllable: 'x'.repeat(41),
      }),
    ).toThrow(/syllable length .* out of range/)
  })

  it('accepts a syllable at the 40-char boundary', () => {
    const next = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'x'.repeat(40),
    })
    expect(next.measures[0].events[0].lyrics?.[0].syllable).toHaveLength(40)
    expect(() => validateScore(next)).not.toThrow()
  })

  it('rejects whitespace-only syllable', () => {
    // Schema allows it (.min(1) is char-count, not non-whitespace),
    // but a syllable that renders as blank under the notehead is
    // almost always a typo. Editor-side guard rejects with an
    // actionable message.
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 1,
        syllable: '   ',
      }),
    ).toThrow(/whitespace-only/)
  })

  it('rejects hyphen:true + extender:true (mutually exclusive)', () => {
    // Engraving convention: a syllable carries EITHER a hyphen
    // (continuation) OR an extender (melisma). Setting both is
    // engraving-nonsense; the visual semantics conflict and the
    // engraver cannot resolve.
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'setLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 1,
        syllable: 'Glo',
        hyphen: true,
        extender: true,
      }),
    ).toThrow(/mutually exclusive/)
  })

  it('attaches a syllable to a rest (Anglican psalter convention)', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
        },
      ],
    }
    const next = applyOperation(sc, {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'A',
    })
    expect(next.measures[0].events[0].lyrics?.[0].syllable).toBe('A')
    expect(() => validateScore(next)).not.toThrow()
  })
})

describe('removeLyric', () => {
  it('removes a specific verse, leaves other verses intact', () => {
    let sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'one',
    })
    sc = applyOperation(sc, {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 2,
      syllable: 'two',
    })
    const removed = applyOperation(sc, {
      kind: 'removeLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
    })
    expect(removed.measures[0].events[0].lyrics).toHaveLength(1)
    expect(removed.measures[0].events[0].lyrics?.[0].verse).toBe(2)
  })

  it('drops the lyrics field entirely when the last verse is removed', () => {
    const sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'only',
    })
    const removed = applyOperation(sc, {
      kind: 'removeLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
    })
    expect(removed.measures[0].events[0].lyrics).toBeUndefined()
  })

  it('is idempotent when the verse is not present (no-op, no throw)', () => {
    const sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'A',
    })
    const removed = applyOperation(sc, {
      kind: 'removeLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 5, // not present
    })
    // verse 1 still there; no throw.
    expect(removed.measures[0].events[0].lyrics?.[0].verse).toBe(1)
  })

  it('rejects out-of-range verse', () => {
    expect(() =>
      applyOperation(buildScore(), {
        kind: 'removeLyric',
        target: { measureIdx: 0, eventIdx: 0 },
        verse: 0,
      }),
    ).toThrow(/verse .* out of range/)
  })
})

describe('clearLyrics', () => {
  it('removes the entire lyrics field on the event', () => {
    let sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'first',
    })
    sc = applyOperation(sc, {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 2,
      syllable: 'second',
    })
    const cleared = applyOperation(sc, {
      kind: 'clearLyrics',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0].lyrics).toBeUndefined()
  })

  it('is a no-op when no lyrics exist (silently succeeds)', () => {
    const cleared = applyOperation(buildScore(), {
      kind: 'clearLyrics',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0].lyrics).toBeUndefined()
  })

  it('does not affect lyrics on OTHER events', () => {
    let sc = applyOperation(buildScore(), {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'A',
    })
    sc = applyOperation(sc, {
      kind: 'setLyric',
      target: { measureIdx: 0, eventIdx: 1 },
      verse: 1,
      syllable: 'B',
    })
    const cleared = applyOperation(sc, {
      kind: 'clearLyrics',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0].lyrics).toBeUndefined()
    expect(cleared.measures[0].events[1].lyrics?.[0].syllable).toBe('B')
  })
})

describe('lyrics on extraVoices (SATB divisi precedent)', () => {
  it('per-voice lyrics: soprano and alto carry different syllables on parallel events', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
    }
    let next = applyOperation(sc, {
      kind: 'setLyric',
      target: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'Ky',
      hyphen: true,
    })
    next = applyOperation(next, {
      kind: 'setLyric',
      target: { staffIdx: 0, voiceIdx: 1, measureIdx: 0, eventIdx: 0 },
      verse: 1,
      syllable: 'Glo',
      hyphen: true,
    })
    expect(next.measures[0].events[0].lyrics?.[0].syllable).toBe('Ky')
    expect(next.extraVoices?.[0].measures[0].events[0].lyrics?.[0].syllable).toBe('Glo')
    expect(() => validateScore(next)).not.toThrow()
  })
})
