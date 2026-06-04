import { describe, it, expect } from 'vitest'
import { applyOperation, EditError } from '@/lib/music/editOperations'
import type { Score } from '@/lib/music/types'

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
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        ],
      },
    ],
  }
}

describe('insertAnnotation', () => {
  it('adds a measure-level rehearsal mark with a minted id', () => {
    const next = applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        measureIdx: 0,
        position: 'above',
        text: 'A',
        style: 'rehearsal-mark',
      },
    })
    expect(next.annotations).toHaveLength(1)
    expect(next.annotations![0].text).toBe('A')
    expect(next.annotations![0].style).toBe('rehearsal-mark')
    expect(next.annotations![0].target.measureIdx).toBe(0)
    expect(next.annotations![0].target.eventIdx).toBeUndefined()
    expect(typeof next.annotations![0].id).toBe('string')
  })

  it('adds an event-level expression mark with eventIdx', () => {
    const next = applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        measureIdx: 0,
        eventIdx: 2,
        position: 'above',
        text: 'cantabile',
        style: 'expression',
      },
    })
    expect(next.annotations![0].target.eventIdx).toBe(2)
  })

  it('appends to existing annotations rather than overwriting', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        measureIdx: 0,
        position: 'above',
        text: 'A',
        style: 'rehearsal-mark',
      },
    })
    const withTwo = applyOperation(withOne, {
      kind: 'insertAnnotation',
      annotation: {
        measureIdx: 1,
        position: 'above',
        text: 'B',
        style: 'rehearsal-mark',
      },
    })
    expect(withTwo.annotations).toHaveLength(2)
    expect(withTwo.annotations!.map((a) => a.text)).toEqual(['A', 'B'])
  })

  it('supports spanEnd for line-extending annotations (rit. ____)', () => {
    const next = applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        measureIdx: 0,
        eventIdx: 0,
        position: 'above',
        text: 'rit.',
        style: 'expression',
        spanEnd: { measureIdx: 1, eventIdx: 3 },
      },
    })
    expect(next.annotations![0].spanEnd).toEqual({ measureIdx: 1, eventIdx: 3 })
  })

  it('throws EditError on out-of-range measureIdx', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertAnnotation',
        annotation: {
          measureIdx: 99,
          position: 'above',
          text: 'A',
          style: 'rehearsal-mark',
        },
      }),
    ).toThrow(EditError)
  })

  it('throws EditError on out-of-range eventIdx', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertAnnotation',
        annotation: {
          measureIdx: 0,
          eventIdx: 99,
          position: 'above',
          text: 'A',
          style: 'expression',
        },
      }),
    ).toThrow(EditError)
  })

  it('throws EditError when spanEnd precedes the target (must extend forward)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertAnnotation',
        annotation: {
          measureIdx: 1,
          position: 'above',
          text: 'rit.',
          style: 'expression',
          spanEnd: { measureIdx: 0 },
        },
      }),
    ).toThrow(/precedes target/)
  })

  it('throws EditError on id collision with an existing annotation', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        id: 'rehearse01',
        measureIdx: 0,
        position: 'above',
        text: 'A',
        style: 'rehearsal-mark',
      },
    })
    expect(() =>
      applyOperation(withOne, {
        kind: 'insertAnnotation',
        annotation: {
          id: 'rehearse01',
          measureIdx: 1,
          position: 'above',
          text: 'B',
          style: 'rehearsal-mark',
        },
      }),
    ).toThrow(/collides/)
  })
})

describe('removeAnnotation', () => {
  it('removes by id', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        id: 'tempo00001',
        measureIdx: 0,
        position: 'above',
        text: 'Allegro',
        style: 'tempo-text',
      },
    })
    const cleared = applyOperation(withOne, { kind: 'removeAnnotation', id: 'tempo00001' })
    expect(cleared).not.toHaveProperty('annotations')
  })

  it('preserves other annotations when removing one of many', () => {
    let s = score()
    s = applyOperation(s, {
      kind: 'insertAnnotation',
      annotation: { id: 'rehearse-A', measureIdx: 0, position: 'above', text: 'A', style: 'rehearsal-mark' },
    })
    s = applyOperation(s, {
      kind: 'insertAnnotation',
      annotation: { id: 'rehearse-B', measureIdx: 1, position: 'above', text: 'B', style: 'rehearsal-mark' },
    })
    const removed = applyOperation(s, { kind: 'removeAnnotation', id: 'rehearse-A' })
    expect(removed.annotations).toHaveLength(1)
    expect(removed.annotations![0].id).toBe('rehearse-B')
  })

  it('throws EditError when id is not found', () => {
    expect(() => applyOperation(score(), { kind: 'removeAnnotation', id: 'absent000' })).toThrow(
      EditError,
    )
  })
})

describe('updateAnnotation', () => {
  function withAnnotation() {
    return applyOperation(score(), {
      kind: 'insertAnnotation',
      annotation: {
        id: 'annotate01',
        measureIdx: 0,
        position: 'above',
        text: 'Allegro',
        style: 'tempo-text',
        spanEnd: { measureIdx: 1, eventIdx: 3 },
      },
    })
  }

  it('patches text only without touching other fields', () => {
    const updated = applyOperation(withAnnotation(), {
      kind: 'updateAnnotation',
      id: 'annotate01',
      patch: { text: 'Allegretto' },
    })
    const a = updated.annotations![0]
    expect(a.text).toBe('Allegretto')
    expect(a.style).toBe('tempo-text')
    expect(a.spanEnd).toEqual({ measureIdx: 1, eventIdx: 3 })
  })

  it('patches style', () => {
    const updated = applyOperation(withAnnotation(), {
      kind: 'updateAnnotation',
      id: 'annotate01',
      patch: { style: 'expression' },
    })
    expect(updated.annotations![0].style).toBe('expression')
  })

  it('re-anchors target', () => {
    const updated = applyOperation(withAnnotation(), {
      kind: 'updateAnnotation',
      id: 'annotate01',
      patch: { target: { measureIdx: 1, position: 'below' } },
    })
    expect(updated.annotations![0].target).toEqual({ measureIdx: 1, position: 'below' })
  })

  it('clears spanEnd with patch.spanEnd: null', () => {
    const updated = applyOperation(withAnnotation(), {
      kind: 'updateAnnotation',
      id: 'annotate01',
      patch: { spanEnd: null },
    })
    expect(updated.annotations![0]).not.toHaveProperty('spanEnd')
  })

  it('replaces spanEnd with patch.spanEnd: object', () => {
    const updated = applyOperation(withAnnotation(), {
      kind: 'updateAnnotation',
      id: 'annotate01',
      patch: { spanEnd: { measureIdx: 1, eventIdx: 0 } },
    })
    expect(updated.annotations![0].spanEnd).toEqual({ measureIdx: 1, eventIdx: 0 })
  })

  it('throws EditError when id is not found', () => {
    expect(() =>
      applyOperation(withAnnotation(), {
        kind: 'updateAnnotation',
        id: 'absent000',
        patch: { text: 'X' },
      }),
    ).toThrow(EditError)
  })

  it('throws EditError when patched target is out of range', () => {
    expect(() =>
      applyOperation(withAnnotation(), {
        kind: 'updateAnnotation',
        id: 'annotate01',
        patch: { target: { measureIdx: 99, position: 'above' } },
      }),
    ).toThrow(/out of range/)
  })
})

describe('setScoreMetadata', () => {
  it('sets composer when patch.composer is a string', () => {
    const next = applyOperation(score(), {
      kind: 'setScoreMetadata',
      patch: { composer: 'J. S. Bach' },
    })
    expect(next.composer).toBe('J. S. Bach')
  })

  it('sets multiple fields in one op', () => {
    const next = applyOperation(score(), {
      kind: 'setScoreMetadata',
      patch: {
        title: 'Invention 1',
        composer: 'J. S. Bach',
        copyright: '© Public domain',
      },
    })
    expect(next.title).toBe('Invention 1')
    expect(next.composer).toBe('J. S. Bach')
    expect(next.copyright).toBe('© Public domain')
  })

  it('clears a field when patch value is null', () => {
    const seeded = applyOperation(score(), {
      kind: 'setScoreMetadata',
      patch: { composer: 'J. S. Bach' },
    })
    const cleared = applyOperation(seeded, {
      kind: 'setScoreMetadata',
      patch: { composer: null },
    })
    expect(cleared).not.toHaveProperty('composer')
  })

  it('preserves untouched fields when patch is sparse', () => {
    const seeded = applyOperation(score(), {
      kind: 'setScoreMetadata',
      patch: { title: 'X', composer: 'Y' },
    })
    const titleOnly = applyOperation(seeded, {
      kind: 'setScoreMetadata',
      patch: { title: 'Z' },
    })
    expect(titleOnly.title).toBe('Z')
    expect(titleOnly.composer).toBe('Y')
  })

  it('rejects empty-string values (pass null to clear)', () => {
    expect(() =>
      applyOperation(score(), { kind: 'setScoreMetadata', patch: { title: '' } }),
    ).toThrow(/empty string/)
  })

  it('empty patch is a no-op (returns same content)', () => {
    const next = applyOperation(score(), { kind: 'setScoreMetadata', patch: {} })
    expect(next.title).toBeUndefined()
    expect(next.composer).toBeUndefined()
  })
})
