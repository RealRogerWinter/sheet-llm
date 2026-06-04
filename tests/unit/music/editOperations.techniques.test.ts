import { describe, it, expect } from 'vitest'
import { applyOperation, transformScore, EditError } from '@/lib/music/editOperations'
import { createTechniqueChange } from '@/lib/music/techniques'
import type { Score } from '@/lib/music/types'

const BASE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 3 }], duration: 'whole' }] },
  ],
}

describe('editOperations — insertTechniqueChange', () => {
  it('appends to score.techniqueStates and mints an id when missing', () => {
    const next = applyOperation(BASE, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        measureIdx: 0,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'pizz',
      },
    })
    expect(next.techniqueStates).toHaveLength(1)
    const change = next.techniqueStates![0]
    expect(change.kind).toBe('pizz')
    expect(change.measureIdx).toBe(0)
    expect(typeof change.id).toBe('string')
    expect(change.id!.length).toBeGreaterThanOrEqual(8)
  })

  it('preserves an explicitly-supplied id (editor-minted)', () => {
    const next = applyOperation(BASE, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        id: 'editor-id-x',
        measureIdx: 1,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'arco',
      },
    })
    expect(next.techniqueStates![0].id).toBe('editor-id-x')
  })

  it('appends rather than replacing existing techniqueStates', () => {
    const seed: Score = { ...BASE, techniqueStates: [createTechniqueChange(0, 0, 0, 'pizz')] }
    const next = applyOperation(seed, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        measureIdx: 2,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'arco',
      },
    })
    expect(next.techniqueStates).toHaveLength(2)
    expect(next.techniqueStates![0].kind).toBe('pizz')
    expect(next.techniqueStates![1].kind).toBe('arco')
  })

  it('persists eventIdx when supplied', () => {
    const fineGrained: Score = {
      ...BASE,
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'D', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'E', octave: 3 }], duration: 'quarter' },
            { pitches: [{ step: 'F', octave: 3 }], duration: 'quarter' },
          ],
        },
      ],
    }
    const next = applyOperation(fineGrained, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        measureIdx: 0,
        eventIdx: 2,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'sul-ponticello',
      },
    })
    expect(next.techniqueStates![0].eventIdx).toBe(2)
  })

  it('rejects an out-of-range measureIdx', () => {
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: {
          measureIdx: 99,
          staffIdx: 0,
          voiceIdx: 0,
          kind: 'pizz',
        },
      }),
    ).toThrow(EditError)
  })

  it('rejects an out-of-range eventIdx', () => {
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: {
          measureIdx: 0,
          eventIdx: 5,
          staffIdx: 0,
          voiceIdx: 0,
          kind: 'pizz',
        },
      }),
    ).toThrow(/eventIdx 5 out of range/)
  })

  it('rejects an out-of-range staffIdx', () => {
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: {
          measureIdx: 0,
          staffIdx: 1,
          voiceIdx: 0,
          kind: 'pizz',
        },
      }),
    ).toThrow(EditError)
  })

  it('rejects an out-of-range voiceIdx', () => {
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: {
          measureIdx: 0,
          staffIdx: 0,
          voiceIdx: 2,
          kind: 'pizz',
        },
      }),
    ).toThrow(EditError)
  })

  it('still validates through applyOperation (full Score check)', () => {
    expect(() =>
      applyOperation(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: {
          measureIdx: 0,
          staffIdx: 0,
          voiceIdx: 0,
          kind: 'col-legno-battuto',
        },
      }),
    ).not.toThrow()
  })

  it('accepts eventIdx 0 (boundary)', () => {
    const next = applyOperation(BASE, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        measureIdx: 0,
        eventIdx: 0,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'pizz',
      },
    })
    expect(next.techniqueStates![0].eventIdx).toBe(0)
  })

  it('rejects negative measureIdx / eventIdx / staffIdx', () => {
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: { measureIdx: -1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      }),
    ).toThrow(EditError)
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: { measureIdx: 0, eventIdx: -1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      }),
    ).toThrow(EditError)
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: { measureIdx: 0, staffIdx: -1, voiceIdx: 0, kind: 'pizz' },
      }),
    ).toThrow(EditError)
    expect(() =>
      transformScore(BASE, {
        kind: 'insertTechniqueChange',
        techniqueChange: { measureIdx: 0, staffIdx: 0, voiceIdx: -1, kind: 'pizz' },
      }),
    ).toThrow(EditError)
  })

  it('rejects an LLM-supplied id that collides with an existing entry', () => {
    const a = createTechniqueChange(0, 0, 0, 'pizz')
    const seed: Score = { ...BASE, techniqueStates: [a] }
    expect(() =>
      transformScore(seed, {
        kind: 'insertTechniqueChange',
        techniqueChange: {
          id: a.id!,
          measureIdx: 2,
          staffIdx: 0,
          voiceIdx: 0,
          kind: 'arco',
        },
      }),
    ).toThrow(/collides/)
  })

  it('works on the secondStaff voice (staffIdx 1)', () => {
    const grand: Score = {
      ...BASE,
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 2 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 2 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'E', octave: 2 }], duration: 'whole' }] },
        ],
      },
    }
    const next = applyOperation(grand, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        measureIdx: 0,
        staffIdx: 1,
        voiceIdx: 0,
        kind: 'pizz',
      },
    })
    expect(next.techniqueStates![0].staffIdx).toBe(1)
  })
})

describe('editOperations — removeTechniqueChange', () => {
  it('removes the matching id from techniqueStates', () => {
    const a = createTechniqueChange(0, 0, 0, 'pizz')
    const b = createTechniqueChange(2, 0, 0, 'arco')
    const seed: Score = { ...BASE, techniqueStates: [a, b] }
    const next = applyOperation(seed, {
      kind: 'removeTechniqueChange',
      id: a.id!,
    })
    expect(next.techniqueStates).toHaveLength(1)
    expect(next.techniqueStates![0].id).toBe(b.id)
  })

  it('drops the techniqueStates key entirely when removing the last entry', () => {
    const a = createTechniqueChange(0, 0, 0, 'pizz')
    const seed: Score = { ...BASE, techniqueStates: [a] }
    const next = applyOperation(seed, {
      kind: 'removeTechniqueChange',
      id: a.id!,
    })
    expect(next.techniqueStates).toBeUndefined()
  })

  it('throws when id is unknown so the LLM can retry with correction', () => {
    const a = createTechniqueChange(0, 0, 0, 'pizz')
    const seed: Score = { ...BASE, techniqueStates: [a] }
    expect(() =>
      transformScore(seed, {
        kind: 'removeTechniqueChange',
        id: 'no-such-id',
      }),
    ).toThrow(/not found/)
  })

  it('throws when techniqueStates is missing', () => {
    expect(() =>
      transformScore(BASE, {
        kind: 'removeTechniqueChange',
        id: 'whatever',
      }),
    ).toThrow(/not found/)
  })

  it('does not affect other voices on the same score', () => {
    // Score with an extraVoices entry so a marker on voiceIdx 1 is
    // valid (validateTechniqueStates added in this same PR rejects
    // markers that address a non-existent voice).
    const twoVoice: Score = {
      ...BASE,
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 3 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'F', octave: 3 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'G', octave: 3 }], duration: 'whole' }] },
          ],
        },
      ],
    }
    const a = createTechniqueChange(0, 0, 0, 'pizz')
    const b = createTechniqueChange(0, 0, 1, 'sul-ponticello')
    const seed: Score = { ...twoVoice, techniqueStates: [a, b] }
    const next = applyOperation(seed, {
      kind: 'removeTechniqueChange',
      id: a.id!,
    })
    expect(next.techniqueStates).toHaveLength(1)
    expect(next.techniqueStates![0].voiceIdx).toBe(1)
  })
})

describe('editOperations — insert + remove round-trip', () => {
  it('inserts then removes yields the original score (sans techniqueStates)', () => {
    const inserted = applyOperation(BASE, {
      kind: 'insertTechniqueChange',
      techniqueChange: {
        id: 'roundtrip-1',
        measureIdx: 1,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'sul-tasto',
      },
    })
    const removed = applyOperation(inserted, {
      kind: 'removeTechniqueChange',
      id: 'roundtrip-1',
    })
    expect(removed.techniqueStates).toBeUndefined()
  })

  it('two insertions in sequence both land with distinct ids', () => {
    let next = applyOperation(BASE, {
      kind: 'insertTechniqueChange',
      techniqueChange: { measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
    })
    next = applyOperation(next, {
      kind: 'insertTechniqueChange',
      techniqueChange: { measureIdx: 2, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
    })
    expect(next.techniqueStates).toHaveLength(2)
    expect(next.techniqueStates![0].id).not.toBe(next.techniqueStates![1].id)
  })
})
