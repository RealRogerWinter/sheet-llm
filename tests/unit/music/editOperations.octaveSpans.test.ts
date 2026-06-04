import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { OCTAVE_SPAN_KINDS, isOctaveSpan, createSpan } from '@/lib/music/spans'
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

describe('OCTAVE_SPAN_KINDS + isOctaveSpan (M20-PR-1)', () => {
  it('exposes all 4 octave-displacement kinds', () => {
    expect([...OCTAVE_SPAN_KINDS]).toEqual(['8va', '8vb', '15ma', '15mb'])
  })

  it('isOctaveSpan returns true for 8va/8vb/15ma/15mb, false otherwise', () => {
    expect(isOctaveSpan(createSpan('8va', idA, idD))).toBe(true)
    expect(isOctaveSpan(createSpan('8vb', idA, idD))).toBe(true)
    expect(isOctaveSpan(createSpan('15ma', idA, idD))).toBe(true)
    expect(isOctaveSpan(createSpan('15mb', idA, idD))).toBe(true)
    expect(isOctaveSpan(createSpan('slur', idA, idD))).toBe(false)
    expect(isOctaveSpan(createSpan('hairpin-cresc', idA, idD))).toBe(false)
    expect(isOctaveSpan(createSpan('accel', idA, idD))).toBe(false)
    expect(isOctaveSpan(createSpan('glissando', idA, idD))).toBe(false)
    expect(isOctaveSpan(createSpan('trill-line', idA, idD))).toBe(false)
  })
})

describe('insertOctaveSpan (M20-PR-1)', () => {
  it('adds a basic 8va span with minted id; survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('8va')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idD)
    expect(typeof next.spans![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds an 8vb span (octave down)', () => {
    const next = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8vb', startEventId: idA, endEventId: idD },
    })
    expect(next.spans![0].kind).toBe('8vb')
  })

  it('adds a 15ma span (two octaves up)', () => {
    const next = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '15ma', startEventId: idA, endEventId: idD },
    })
    expect(next.spans![0].kind).toBe('15ma')
  })

  it('adds a 15mb span (two octaves down)', () => {
    const next = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '15mb', startEventId: idA, endEventId: idD },
    })
    expect(next.spans![0].kind).toBe('15mb')
  })

  it('honors explicit placement', () => {
    const next = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: {
        kind: '8va',
        startEventId: idA,
        endEventId: idD,
        placement: 'above',
      },
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertOctaveSpan',
        octaveSpan: { kind: '8va', startEventId: 'doesnotexist', endEventId: idD },
      }),
    ).toThrow(/startEventId .* does not match/)
  })

  it('rejects missing endEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertOctaveSpan',
        octaveSpan: { kind: '8vb', startEventId: idA, endEventId: 'doesnotexist' },
      }),
    ).toThrow(/endEventId .* does not match/)
  })

  it('rejects reversed start/end (must extend forward)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertOctaveSpan',
        octaveSpan: { kind: '8va', startEventId: idD, endEventId: idA },
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
        kind: 'insertOctaveSpan',
        octaveSpan: {
          kind: '8va',
          id: existingId,
          startEventId: idA,
          endEventId: idD,
        },
      }),
    ).toThrow(/collides with an existing span/)
  })

  it('rejects mismatched staffIdx/voiceIdx vs start event location', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertOctaveSpan',
        octaveSpan: {
          kind: '8va',
          startEventId: idA,
          endEventId: idD,
          staffIdx: 1, // wrong; event idA is staff 0
        },
      }),
    ).toThrow(/does not match the start event's location/)
  })

  it('cross-measure span via measure-2 endpoint', () => {
    const next = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idB, endEventId: idF },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].startEventId).toBe(idB)
    expect(next.spans![0].endEventId).toBe(idF)
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
        kind: 'insertOctaveSpan',
        octaveSpan: { kind: '8va', startEventId: idA, endEventId: idB },
      }),
    ).toThrow(/different staves\/voices.*not supported in Phase 1/)
  })
})

describe('removeOctaveSpan (M20-PR-1)', () => {
  it('removes an octave span by id; drops spans array when last', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, { kind: 'removeOctaveSpan', id })
    expect(next.spans).toBeUndefined()
  })

  it('rejects removing a non-octave span via removeOctaveSpan', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() => applyOperation(sc, { kind: 'removeOctaveSpan', id })).toThrow(
      /not an octave span/,
    )
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeOctaveSpan', id: 'notreallyid' }),
    ).toThrow(/not found/)
  })

  it('preserves OTHER spans when removing one octave span', () => {
    let sc = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD },
    })
    const slurId = 'preservedid'
    sc = {
      ...sc,
      spans: [...(sc.spans ?? []), { ...createSpan('slur', idE, idF), id: slurId }],
    }
    const octaveId = sc.spans![0].id!
    const next = applyOperation(sc, { kind: 'removeOctaveSpan', id: octaveId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].id).toBe(slurId)
  })
})

describe('updateOctaveSpan (M20-PR-1)', () => {
  it('patches kind 8va → 15ma', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateOctaveSpan',
      id,
      patch: { kind: '15ma' },
    })
    expect(next.spans![0].kind).toBe('15ma')
  })

  it('null clears placement', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateOctaveSpan',
      id,
      patch: { placement: null },
    })
    expect(next.spans![0].placement).toBeUndefined()
  })

  it('undefined preserves prior placement (carry semantics)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateOctaveSpan',
      id,
      patch: { kind: '15ma' },
    })
    expect(next.spans![0].kind).toBe('15ma')
    expect(next.spans![0].placement).toBe('above')
  })

  it('endpoint re-anchor revalidates forward order', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateOctaveSpan',
        id,
        patch: { startEventId: idD, endEventId: idA }, // reversed
      }),
    ).toThrow(/start .* is AFTER end/)
  })

  it('rejects re-anchor to missing event', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateOctaveSpan',
        id,
        patch: { endEventId: 'doesnotexist' },
      }),
    ).toThrow(/does not match any event/)
  })

  it('empty patch is a no-op (all fields carry)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertOctaveSpan',
      octaveSpan: { kind: '8va', startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateOctaveSpan',
      id,
      patch: {},
    })
    expect(next.spans![0].kind).toBe('8va')
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects update of non-octave span via updateOctaveSpan', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'updateOctaveSpan',
        id,
        patch: { kind: '8va' },
      }),
    ).toThrow(/not an octave span/)
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'updateOctaveSpan',
        id: 'notreallyid',
        patch: { kind: '8vb' },
      }),
    ).toThrow(/not found/)
  })
})
