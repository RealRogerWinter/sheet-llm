import { describe, it, expect } from 'vitest'
import { applyOperation, EditError } from '@/lib/music/editOperations'
import { parseChordSymbol } from '@/lib/music/chordSymbols'
import type { ChordSymbol, Score } from '@/lib/music/types'

function score(): Score {
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

describe('setChordSymbol', () => {
  it('attaches a chord symbol to the target event', () => {
    const cmaj7 = parseChordSymbol('Cmaj7')!
    const next = applyOperation(score(), {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: cmaj7,
    })
    expect(next.measures[0].events[0].chordSymbol).toBeDefined()
    expect(next.measures[0].events[0].chordSymbol!.root).toBe('C')
    expect(next.measures[0].events[0].chordSymbol!.seventh).toBe('maj7')
  })

  it('attaches different chord symbols to different events independently', () => {
    let s = score()
    s = applyOperation(s, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: parseChordSymbol('C')!,
    })
    s = applyOperation(s, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 2 },
      chordSymbol: parseChordSymbol('F')!,
    })
    expect(s.measures[0].events[0].chordSymbol!.root).toBe('C')
    expect(s.measures[0].events[1].chordSymbol).toBeUndefined()
    expect(s.measures[0].events[2].chordSymbol!.root).toBe('F')
  })

  it('overwrites an existing chord symbol on the same event', () => {
    const seeded = applyOperation(score(), {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: parseChordSymbol('C')!,
    })
    const replaced = applyOperation(seeded, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: parseChordSymbol('Dm7')!,
    })
    expect(replaced.measures[0].events[0].chordSymbol!.root).toBe('D')
    expect(replaced.measures[0].events[0].chordSymbol!.quality).toBe('minor')
  })

  it('omitting chordSymbol clears the field entirely (drops the key)', () => {
    const seeded = applyOperation(score(), {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: parseChordSymbol('Cmaj7')!,
    })
    expect(seeded.measures[0].events[0]).toHaveProperty('chordSymbol')
    const cleared = applyOperation(seeded, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    expect(cleared.measures[0].events[0]).not.toHaveProperty('chordSymbol')
  })

  it('preserves a slash-chord bass field across the op', () => {
    const ce = parseChordSymbol('C/E')!
    const next = applyOperation(score(), {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: ce,
    })
    expect(next.measures[0].events[0].chordSymbol!.bass).toEqual({ type: 'note', value: 'E' })
  })

  it('preserves a polychord bass (nested chord) across the op', () => {
    const poly = parseChordSymbol('C|G')!
    const next = applyOperation(score(), {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: poly,
    })
    const bass = next.measures[0].events[0].chordSymbol!.bass
    expect(bass?.type).toBe('chord')
    if (bass?.type === 'chord') expect(bass.value.root).toBe('G')
  })

  it('preserves a modal symbol (root + modal tag)', () => {
    const cmix = parseChordSymbol('C Mixolydian')!
    const next = applyOperation(score(), {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: cmix,
    })
    expect(next.measures[0].events[0].chordSymbol!.modal).toBe('Mixolydian')
  })

  it('chord symbol coexists with other event-level fields on the same note', () => {
    let s = score()
    s = applyOperation(s, {
      kind: 'setDynamic',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic: 'p',
    })
    s = applyOperation(s, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: parseChordSymbol('Cmaj7')!,
    })
    const e = s.measures[0].events[0]
    expect(e.chordSymbol!.seventh).toBe('maj7')
    expect(e.dynamic).toBe('p')
  })

  it('malformed chord symbol (invalid root) is rejected by applyOperation as EditError', () => {
    // Locks the validation contract at the op boundary —
    // applyOperation runs validateScore downstream, so the
    // ChordSymbolSchema (NoteNameSchema on root + regex on
    // alterations) rejects bad shapes before they persist. Documents
    // the safety net that prevents the LLM or a malformed UI patch
    // from corrupting the score JSON.
    expect(() =>
      applyOperation(score(), {
        kind: 'setChordSymbol',
        target: { measureIdx: 0, eventIdx: 0 },
        chordSymbol: {
          root: 'Z',
          quality: 'major',
          seventh: 'none',
        } as ChordSymbol,
      }),
    ).toThrow(EditError)
  })

  it('clearing chord symbol leaves other event fields intact', () => {
    let s = score()
    s = applyOperation(s, {
      kind: 'setDynamic',
      target: { measureIdx: 0, eventIdx: 0 },
      dynamic: 'mf',
    })
    s = applyOperation(s, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
      chordSymbol: parseChordSymbol('Cmaj7')!,
    })
    s = applyOperation(s, {
      kind: 'setChordSymbol',
      target: { measureIdx: 0, eventIdx: 0 },
    })
    const e = s.measures[0].events[0]
    expect(e).not.toHaveProperty('chordSymbol')
    expect(e.dynamic).toBe('mf')
  })
})
