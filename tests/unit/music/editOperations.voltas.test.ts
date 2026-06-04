import { describe, it, expect } from 'vitest'
import { applyOperation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ensureVoltaIds } from '@/lib/music/spans'
import type { Score } from '@/lib/music/types'

function fourBars(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    ],
  }
}

describe('insertVolta', () => {
  it('adds a 1st-time-only volta on m=2', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: {
        startMeasureIdx: 2,
        endMeasureIdx: 2,
        endings: [1],
      },
    })
    expect(next.voltas).toHaveLength(1)
    expect(next.voltas![0].startMeasureIdx).toBe(2)
    expect(next.voltas![0].endMeasureIdx).toBe(2)
    expect(next.voltas![0].endings).toEqual([1])
    expect(typeof next.voltas![0].id).toBe('string')
    expect(() => validateScore(next)).not.toThrow()
  })

  it('adds a 1st-and-2nd-time volta over a 2-bar range', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: {
        startMeasureIdx: 0,
        endMeasureIdx: 1,
        endings: [1, 2],
      },
    })
    expect(next.voltas![0].endings).toEqual([1, 2])
  })

  it('honors endHook + text optional fields', () => {
    const next = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: {
        startMeasureIdx: 1,
        endMeasureIdx: 2,
        endings: [1],
        endHook: 'open',
        text: 'First time',
      },
    })
    expect(next.voltas![0].endHook).toBe('open')
    expect(next.voltas![0].text).toBe('First time')
  })

  it('rejects startMeasureIdx > endMeasureIdx (reversed)', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 3,
          endMeasureIdx: 1,
          endings: [1],
        },
      }),
    ).toThrow(/is after endMeasureIdx/)
  })

  it('rejects out-of-range startMeasureIdx', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 10,
          endMeasureIdx: 10,
          endings: [1],
        },
      }),
    ).toThrow(/startMeasureIdx .* out of range/)
  })

  it('rejects out-of-range endMeasureIdx', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 0,
          endMeasureIdx: 99,
          endings: [1],
        },
      }),
    ).toThrow(/endMeasureIdx .* out of range/)
  })

  it('rejects empty endings array', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 0,
          endMeasureIdx: 1,
          endings: [],
        },
      }),
    ).toThrow(/endings array must have 1\.\.9/)
  })

  it('rejects endings > 9', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 0,
          endMeasureIdx: 1,
          endings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        },
      }),
    ).toThrow(/must have 1\.\.9 entries|out of range/)
  })

  it('rejects ending value outside 1..9', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 0,
          endMeasureIdx: 1,
          endings: [0],
        },
      }),
    ).toThrow(/out of range/)
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 0,
          endMeasureIdx: 1,
          endings: [10],
        },
      }),
    ).toThrow(/out of range/)
  })

  it('rejects duplicate endings', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'insertVolta',
        volta: {
          startMeasureIdx: 0,
          endMeasureIdx: 1,
          endings: [1, 1, 2],
        },
      }),
    ).toThrow(/duplicates/)
  })

  it('rejects id collision', () => {
    const sc = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 0, endings: [1] },
    })
    const existingId = sc.voltas![0].id!
    expect(() =>
      applyOperation(sc, {
        kind: 'insertVolta',
        volta: {
          id: existingId,
          startMeasureIdx: 1,
          endMeasureIdx: 1,
          endings: [2],
        },
      }),
    ).toThrow(/collides with an existing volta/)
  })
})

describe('removeVolta', () => {
  it('removes a volta by id', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 1, endings: [1] },
    })
    const id = inserted.voltas![0].id!
    const next = applyOperation(inserted, { kind: 'removeVolta', id })
    expect(next.voltas).toBeUndefined()
  })

  it('rejects unknown id', () => {
    expect(() =>
      applyOperation(fourBars(), { kind: 'removeVolta', id: 'notreallyid' }),
    ).toThrow(/not found/)
  })

  it('preserves OTHER voltas when removing one', () => {
    let sc = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 0, endings: [1] },
    })
    sc = applyOperation(sc, {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 1, endMeasureIdx: 1, endings: [2] },
    })
    const firstId = sc.voltas![0].id!
    const next = applyOperation(sc, { kind: 'removeVolta', id: firstId })
    expect(next.voltas).toHaveLength(1)
    expect(next.voltas![0].endings).toEqual([2])
  })
})

describe('updateVolta', () => {
  it('patches startMeasureIdx and endMeasureIdx together', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 1, endings: [1] },
    })
    const id = inserted.voltas![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateVolta',
      id,
      patch: { startMeasureIdx: 2, endMeasureIdx: 3 },
    })
    expect(next.voltas![0].startMeasureIdx).toBe(2)
    expect(next.voltas![0].endMeasureIdx).toBe(3)
  })

  it('patches endings array', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 1, endings: [1] },
    })
    const id = inserted.voltas![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateVolta',
      id,
      patch: { endings: [1, 2, 3] },
    })
    expect(next.voltas![0].endings).toEqual([1, 2, 3])
  })

  it('null clears endHook', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: {
        startMeasureIdx: 0,
        endMeasureIdx: 1,
        endings: [1],
        endHook: 'closed',
      },
    })
    const id = inserted.voltas![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateVolta',
      id,
      patch: { endHook: null },
    })
    expect(next.voltas![0].endHook).toBeUndefined()
  })

  it('null clears text', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: {
        startMeasureIdx: 0,
        endMeasureIdx: 1,
        endings: [1],
        text: 'First time',
      },
    })
    const id = inserted.voltas![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateVolta',
      id,
      patch: { text: null },
    })
    expect(next.voltas![0].text).toBeUndefined()
  })

  it('rejects update of unknown id', () => {
    expect(() =>
      applyOperation(fourBars(), {
        kind: 'updateVolta',
        id: 'doesnotexist',
        patch: { endings: [1] },
      }),
    ).toThrow(/not found/)
  })

  it('rejects reversed range in patch', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 1, endings: [1] },
    })
    const id = inserted.voltas![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateVolta',
        id,
        patch: { startMeasureIdx: 3, endMeasureIdx: 0 },
      }),
    ).toThrow(/is after endMeasureIdx/)
  })

  it('rejects duplicate endings in patch', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: { startMeasureIdx: 0, endMeasureIdx: 1, endings: [1] },
    })
    const id = inserted.voltas![0].id!
    expect(() =>
      applyOperation(inserted, {
        kind: 'updateVolta',
        id,
        patch: { endings: [2, 2] },
      }),
    ).toThrow(/duplicates/)
  })

  it('empty patch is a no-op (all fields carry)', () => {
    const inserted = applyOperation(fourBars(), {
      kind: 'insertVolta',
      volta: {
        startMeasureIdx: 0,
        endMeasureIdx: 1,
        endings: [1, 2],
        endHook: 'open',
        text: 'First',
      },
    })
    const id = inserted.voltas![0].id!
    const next = applyOperation(inserted, {
      kind: 'updateVolta',
      id,
      patch: {},
    })
    expect(next.voltas![0].startMeasureIdx).toBe(0)
    expect(next.voltas![0].endMeasureIdx).toBe(1)
    expect(next.voltas![0].endings).toEqual([1, 2])
    expect(next.voltas![0].endHook).toBe('open')
    expect(next.voltas![0].text).toBe('First')
  })
})

describe('ensureVoltaIds', () => {
  it('backfills ids on voltas missing them', () => {
    const input = {
      voltas: [
        { startMeasureIdx: 0, endMeasureIdx: 0, endings: [1] },
        { id: 'existingid', startMeasureIdx: 1, endMeasureIdx: 1, endings: [2] },
      ],
    }
    ensureVoltaIds(input)
    expect(typeof input.voltas[0].id).toBe('string')
    expect((input.voltas[0] as { id: string }).id.length).toBeGreaterThanOrEqual(8)
    expect(input.voltas[1].id).toBe('existingid')
  })

  it('is safe on non-Score inputs (defensive no-op)', () => {
    expect(ensureVoltaIds(undefined)).toBeUndefined()
    expect(ensureVoltaIds({})).toEqual({})
    expect(ensureVoltaIds({ voltas: 'not an array' })).toEqual({ voltas: 'not an array' })
  })
})
