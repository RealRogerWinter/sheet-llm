import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { TREMOLO_BETWEEN_KIND, isTremoloBetween, createSpan } from '@/lib/music/spans'
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

describe('TREMOLO_BETWEEN_KIND + isTremoloBetween (M20-PR-1)', () => {
  it('exposes the kind constant', () => {
    expect(TREMOLO_BETWEEN_KIND).toBe('tremolo-between')
  })

  it('isTremoloBetween returns true for tremolo-between, false otherwise', () => {
    expect(isTremoloBetween(createSpan('tremolo-between', idA, idD))).toBe(true)
    expect(isTremoloBetween(createSpan('slur', idA, idD))).toBe(false)
    expect(isTremoloBetween(createSpan('hairpin-cresc', idA, idD))).toBe(false)
    expect(isTremoloBetween(createSpan('8va', idA, idD))).toBe(false)
    expect(isTremoloBetween(createSpan('glissando', idA, idD))).toBe(false)
    expect(isTremoloBetween(createSpan('trill-line', idA, idD))).toBe(false)
  })
})

describe('insertTremoloBetween (M20-PR-1)', () => {
  it('adds a basic tremolo-between span with minted id; survives validateScore', () => {
    const next = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].kind).toBe('tremolo-between')
    expect(next.spans![0].startEventId).toBe(idA)
    expect(next.spans![0].endEventId).toBe(idB)
    expect(typeof next.spans![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('honors explicit placement', () => {
    const next = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB, placement: 'above' },
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects missing startEventId', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTremoloBetween',
        tremoloBetween: { startEventId: 'doesnotexist', endEventId: idB },
      }),
    ).toThrow(/startEventId .* does not match/)
  })

  it('rejects reversed start/end (must extend forward)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertTremoloBetween',
        tremoloBetween: { startEventId: idD, endEventId: idA },
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
        kind: 'insertTremoloBetween',
        tremoloBetween: { id: existingId, startEventId: idA, endEventId: idB },
      }),
    ).toThrow(/collides with an existing span/)
  })

  it('cross-measure tremolo works (B section)', () => {
    const next = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idE, endEventId: idF },
    })
    expect(next.spans).toHaveLength(1)
    expect(next.spans![0].startEventId).toBe(idE)
    expect(next.spans![0].endEventId).toBe(idF)
  })

  it('same-event tremolo is permitted (start === end forward-equal range, matches hairpin precedent for valid limit case)', () => {
    // Mirrors editOperations.hairpins.test.ts pin for `start === end`
    // being valid (e.g. fz wedge collapsed onto a single note). The
    // forward-only check uses `>`, not `>=`, so same-event spans pass
    // validation across all 7 span families.
    const next = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idA },
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
        kind: 'insertTremoloBetween',
        tremoloBetween: { startEventId: idA, endEventId: idB },
      }),
    ).toThrow(/different staves\/voices.*not supported in Phase 1/)
  })
})

describe('removeTremoloBetween (M20-PR-1)', () => {
  it('removes a tremolo-between by id; drops spans array when last', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, { kind: 'removeTremoloBetween', id })
    expect(next.spans).toBeUndefined()
  })

  it('rejects removing a non-tremolo-between span via removeTremoloBetween', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() => applyOperation(sc, { kind: 'removeTremoloBetween', id })).toThrow(
      /not a tremolo-between/,
    )
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeTremoloBetween', id: 'notreallyid' }),
    ).toThrow(/not found/)
  })
})

describe('updateTremoloBetween (M20-PR-1)', () => {
  it('null clears placement', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTremoloBetween',
      id,
      patch: { placement: null },
    })
    expect(next.spans![0].placement).toBeUndefined()
  })

  it('undefined preserves prior placement (carry semantics)', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTremoloBetween',
      id,
      patch: { endEventId: idC },
    })
    expect(next.spans![0].endEventId).toBe(idC)
    expect(next.spans![0].placement).toBe('above')
  })

  it('endpoint re-anchor revalidates forward order', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB },
    })
    const id = inserted.spans![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateTremoloBetween',
        id,
        patch: { startEventId: idD, endEventId: idA },
      }),
    ).toThrow(/start .* is AFTER end/)
  })

  it('empty patch is a no-op', () => {
    const inserted = applyOperation(score(), {
      kind: 'insertTremoloBetween',
      tremoloBetween: { startEventId: idA, endEventId: idB, placement: 'above' },
    })
    const id = inserted.spans![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateTremoloBetween',
      id,
      patch: {},
    })
    expect(next.spans![0].placement).toBe('above')
  })

  it('rejects update of non-tremolo-between via updateTremoloBetween', () => {
    const sc: Score = {
      ...score(),
      spans: [createSpan('slur', idA, idD)],
    }
    const id = sc.spans![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'updateTremoloBetween',
        id,
        patch: { placement: 'above' },
      }),
    ).toThrow(/not a tremolo-between/)
  })
})
