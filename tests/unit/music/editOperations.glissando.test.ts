import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { GLISSANDO_KIND, isGlissando, createSpan } from '@/lib/music/spans'
import type { Score } from '@/lib/music/types'

const idA = 'evtestid01'
const idB = 'evtestid02'
const idC = 'evtestid03'
const idD = 'evtestid04'
const idE = 'evtestid05'
const idF = 'evtestid06'

function score(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: idA, pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { id: idB, pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { id: idC, pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { id: idD, pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ],
      },
      {
        events: [
          { id: idE, pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          { id: idF, pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
        ],
      },
    ],
  }
}

describe('GLISSANDO_KIND + isGlissando (M20-PR-1)', () => {
  it('exposes the kind constant', () => {
    expect(GLISSANDO_KIND).toBe('glissando')
  })

  it('isGlissando returns true for glissando, false otherwise', () => {
    expect(isGlissando(createSpan('glissando', idA, idD))).toBe(true)
    expect(isGlissando(createSpan('slur', idA, idD))).toBe(false)
    expect(isGlissando(createSpan('hairpin-cresc', idA, idD))).toBe(false)
    expect(isGlissando(createSpan('8va', idA, idD))).toBe(false)
    expect(isGlissando(createSpan('trill-line', idA, idD))).toBe(false)
    expect(isGlissando(createSpan('tremolo-between', idA, idD))).toBe(false)
  })
})

describe('insertGlissando (M20-PR-1)', () => {
  it('adds a basic glissando span with minted id; survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('glissando')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idD)
    expect(typeof next.spans![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a glissando with glissStyle="wavy"', () => {
    const next = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissStyle: 'wavy' },
    })
    expect(next.spans![0].glissStyle).toBe('wavy')
  })

  it('adds a glissando with glissStyle="straight"', () => {
    const next = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissStyle: 'straight' },
    })
    expect(next.spans![0].glissStyle).toBe('straight')
  })

  it('adds a glissando with glissText=true', () => {
    const next = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissText: true },
    })
    expect(next.spans![0].glissText).toBe(true)
  })

  it('adds a glissando with glissText=false explicitly', () => {
    const next = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissText: false },
    })
    expect(next.spans![0].glissText).toBe(false)
  })

  it('adds a glissando with all decorators together', () => {
    const next = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: {
        startEventId: idA,
        endEventId: idD,
        placement: 'above',
        glissStyle: 'wavy',
        glissText: true,
      },
    })
    expect(next.spans![0].placement).toBe('above')
    expect(next.spans![0].glissStyle).toBe('wavy')
    expect(next.spans![0].glissText).toBe(true)
  })

  it('rejects missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertGlissando',
        glissando: { startEventId: 'doesnotexist', endEventId: idD },
      }),
    ).toThrow(/startEventId .* does not match/)
  })

  it('rejects reversed start/end (must extend forward)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertGlissando',
        glissando: { startEventId: idD, endEventId: idA },
      }),
    ).toThrow(/extend FORWARD/)
  })

  it('rejects id collision', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('hairpin-cresc', idA, idB)],
    }
    const existingId = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'insertGlissando',
        glissando: { id: existingId, startEventId: idA, endEventId: idD },
      }),
    ).toThrow(/collides with an existing span/)
  })

  it('rejects endpoints on different staves (cross-staff not supported in Phase 1)', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ id: idA, pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ id: idB, pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
    }
    expect(() =>
      applyOperation(sc, {
        kind: 'insertGlissando',
        glissando: { startEventId: idA, endEventId: idB },
      }),
    ).toThrow(/different staves\/voices.*not supported in Phase 1/)
  })
})

describe('removeGlissando (M20-PR-1)', () => {
  it('removes a glissando by id; drops spans array when last', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, { kind: 'removeGlissando', id })
    expect(next.spans).toBeUndefined()
  })

  it('rejects removing a non-glissando span via removeGlissando', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() => applyOperation(sc, { kind: 'removeGlissando', id })).toThrow(
      /not a glissando/,
    )
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeGlissando', id: 'notreallyid' }),
    ).toThrow(/not found/)
  })
})

describe('updateGlissando (M20-PR-1)', () => {
  it('patches glissStyle wavy → straight', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissStyle: 'wavy' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateGlissando',
      id,
      patch: { glissStyle: 'straight' },
    })
    expect(next.spans![0].glissStyle).toBe('straight')
  })

  it('null clears glissStyle', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissStyle: 'wavy' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateGlissando',
      id,
      patch: { glissStyle: null },
    })
    expect(next.spans![0].glissStyle).toBeUndefined()
  })

  it('null clears glissText', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, glissText: true },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateGlissando',
      id,
      patch: { glissText: null },
    })
    expect(next.spans![0].glissText).toBeUndefined()
  })

  it('null clears placement', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateGlissando',
      id,
      patch: { placement: null },
    })
    expect(next.spans![0].placement).toBeUndefined()
  })

  it('undefined preserves prior values (carry semantics)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: {
        startEventId: idA,
        endEventId: idD,
        glissStyle: 'wavy',
        glissText: true,
        placement: 'above',
      },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateGlissando',
      id,
      patch: { endEventId: idC },
    })
    expect(next.spans![0].endEventId).toBe(idC)
    expect(next.spans![0].glissStyle).toBe('wavy')
    expect(next.spans![0].glissText).toBe(true)
    expect(next.spans![0].placement).toBe('above')
  })

  it('endpoint re-anchor revalidates forward order', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: { startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateGlissando',
        id,
        patch: { startEventId: idD, endEventId: idA }, // reversed
      }),
    ).toThrow(/start .* is AFTER end/)
  })

  it('empty patch is a no-op (all fields carry)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertGlissando',
      glissando: {
        startEventId: idA,
        endEventId: idD,
        placement: 'above',
        glissStyle: 'wavy',
        glissText: true,
      },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateGlissando',
      id,
      patch: {},
    })
    expect(next.spans![0].placement).toBe('above')
    expect(next.spans![0].glissStyle).toBe('wavy')
    expect(next.spans![0].glissText).toBe(true)
  })

  it('rejects update of non-glissando span via updateGlissando', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'updateGlissando',
        id,
        patch: { glissStyle: 'wavy' },
      }),
    ).toThrow(/not a glissando/)
  })
})
