import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { TRILL_LINE_KIND, isTrillLine, createSpan } from '@/lib/music/spans'
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

describe('TRILL_LINE_KIND + isTrillLine (M20-PR-1)', () => {
  it('exposes the kind constant', () => {
    expect(TRILL_LINE_KIND).toBe('trill-line')
  })

  it('isTrillLine returns true for trill-line, false otherwise', () => {
    expect(isTrillLine(createSpan('trill-line', idA, idD))).toBe(true)
    expect(isTrillLine(createSpan('slur', idA, idD))).toBe(false)
    expect(isTrillLine(createSpan('8va', idA, idD))).toBe(false)
    expect(isTrillLine(createSpan('glissando', idA, idD))).toBe(false)
    expect(isTrillLine(createSpan('tremolo-between', idA, idD))).toBe(false)
  })
})

describe('insertTrillLine (M20-PR-1)', () => {
  it('adds a basic trill line with minted id; survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('trill-line')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idD)
    expect(typeof next.spans![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('honors explicit placement', () => {
    const next = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD, placement: 'above' },
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTrillLine',
        trillLine: { startEventId: 'doesnotexist', endEventId: idD },
      }),
    ).toThrow(/startEventId .* does not match/)
  })

  it('rejects missing endEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTrillLine',
        trillLine: { startEventId: idA, endEventId: 'doesnotexist' },
      }),
    ).toThrow(/endEventId .* does not match/)
  })

  it('rejects reversed start/end (must extend forward)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTrillLine',
        trillLine: { startEventId: idD, endEventId: idA },
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
        kind: 'insertTrillLine',
        trillLine: { id: existingId, startEventId: idA, endEventId: idD },
      }),
    ).toThrow(/collides with an existing span/)
  })

  it('rejects mismatched staffIdx vs start event location', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTrillLine',
        trillLine: { startEventId: idA, endEventId: idD, staffIdx: 1 },
      }),
    ).toThrow(/does not match the start event's location/)
  })

  it('cross-measure trill line works', () => {
    const next = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idB, endEventId: idF },
    })
    expect(next.spans).toHaveLength(1)
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
        kind: 'insertTrillLine',
        trillLine: { startEventId: idA, endEventId: idB },
      }),
    ).toThrow(/different staves\/voices.*not supported in Phase 1/)
  })
})

describe('removeTrillLine (M20-PR-1)', () => {
  it('removes a trill line by id; drops spans array when last', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, { kind: 'removeTrillLine', id })
    expect(next.spans).toBeUndefined()
  })

  it('rejects removing a non-trill-line span via removeTrillLine', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() => applyOperation(sc, { kind: 'removeTrillLine', id })).toThrow(
      /not a trill line/,
    )
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeTrillLine', id: 'notreallyid' }),
    ).toThrow(/not found/)
  })

  it('preserves other spans when removing one trill line', () => {
    let sc = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD },
    })
    sc = {
      ...sc,
      spans: [...(sc.spans ?? []), { ...createSpan('slur', idE, idF), id: 'preservedid' }],
    }
    const trillId = sc.spans![0].id!
    const next = applyOperation(sc, { kind: 'removeTrillLine', id: trillId })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].id).toBe('preservedid')
  })
})

describe('updateTrillLine (M20-PR-1)', () => {
  it('null clears placement', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTrillLine',
      id,
      patch: { placement: null },
    })
    expect(next.spans![0].placement).toBeUndefined()
  })

  it('undefined preserves prior placement (carry semantics)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTrillLine',
      id,
      patch: { endEventId: idC },
    })
    expect(next.spans![0].endEventId).toBe(idC)
    expect(next.spans![0].placement).toBe('above')
  })

  it('endpoint re-anchor revalidates forward order', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateTrillLine',
        id,
        patch: { startEventId: idD, endEventId: idA },
      }),
    ).toThrow(/start .* is AFTER end/)
  })

  it('empty patch is a no-op', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTrillLine',
      trillLine: { startEventId: idA, endEventId: idD, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTrillLine',
      id,
      patch: {},
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects update of non-trill-line via updateTrillLine', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'updateTrillLine',
        id,
        patch: { placement: 'above' },
      }),
    ).toThrow(/not a trill line/)
  })
})
