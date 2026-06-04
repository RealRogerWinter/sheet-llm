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

describe('insertMarker', () => {
  it('adds a tempo marker with a minted id', () => {
    const next = applyOperation(score(), {
      kind: 'insertMarker',
      marker: { measureIdx: 1, tempo_bpm: 120, tempo_text: 'Allegro' },
    })
    expect(next.markers).toHaveLength(1)
    expect(next.markers![0].measureIdx).toBe(1)
    expect(next.markers![0].tempo_bpm).toBe(120)
    expect(next.markers![0].tempo_text).toBe('Allegro')
    expect(typeof next.markers![0].id).toBe('string')
  })

  it('adds a metric-modulation marker', () => {
    const next = applyOperation(score(), {
      kind: 'insertMarker',
      marker: {
        measureIdx: 1,
        tempo_bpm: 80,
        metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' },
      },
    })
    expect(next.markers![0].metricModulation).toEqual({
      fromNote: 'quarter',
      toNote: 'dotted-quarter',
    })
  })

  it('appends to existing markers rather than overwriting', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertMarker',
      marker: { measureIdx: 0, tempo_bpm: 100 },
    })
    const withTwo = applyOperation(withOne, {
      kind: 'insertMarker',
      marker: { measureIdx: 1, tempo_bpm: 140 },
    })
    expect(withTwo.markers).toHaveLength(2)
  })

  it('throws EditError on out-of-range measureIdx', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertMarker',
        marker: { measureIdx: 99, tempo_bpm: 100 },
      }),
    ).toThrow(EditError)
  })

  it('throws EditError when no marker fields are set (refine violation surfaced as op error)', () => {
    expect(() =>
      applyOperation(score(), {
        kind: 'insertMarker',
        marker: { measureIdx: 0 },
      }),
    ).toThrow(/at least one of/i)
  })

  it('throws EditError on id collision with an existing marker', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertMarker',
      marker: { id: 'marker0001', measureIdx: 0, tempo_bpm: 100 },
    })
    expect(() =>
      applyOperation(withOne, {
        kind: 'insertMarker',
        marker: { id: 'marker0001', measureIdx: 1, tempo_bpm: 120 },
      }),
    ).toThrow(/collides/)
  })
})

describe('removeMarker', () => {
  it('removes by id', () => {
    const withOne = applyOperation(score(), {
      kind: 'insertMarker',
      marker: { id: 'tempo00001', measureIdx: 0, tempo_bpm: 120 },
    })
    const cleared = applyOperation(withOne, { kind: 'removeMarker', id: 'tempo00001' })
    expect(cleared).not.toHaveProperty('markers')
  })

  it('preserves other markers when removing one of many', () => {
    let s = score()
    s = applyOperation(s, {
      kind: 'insertMarker',
      marker: { id: 'tempo00001', measureIdx: 0, tempo_bpm: 100 },
    })
    s = applyOperation(s, {
      kind: 'insertMarker',
      marker: { id: 'tempo00002', measureIdx: 1, tempo_bpm: 140 },
    })
    const removed = applyOperation(s, { kind: 'removeMarker', id: 'tempo00001' })
    expect(removed.markers).toHaveLength(1)
    expect(removed.markers![0].id).toBe('tempo00002')
  })

  it('throws EditError when id is not found', () => {
    expect(() =>
      applyOperation(score(), { kind: 'removeMarker', id: 'absent000' }),
    ).toThrow(EditError)
  })
})

describe('updateMarker', () => {
  function withMarker() {
    return applyOperation(score(), {
      kind: 'insertMarker',
      marker: {
        id: 'tempo00001',
        measureIdx: 1,
        tempo_bpm: 120,
        tempo_text: 'Allegro',
      },
    })
  }

  it('patches tempo_bpm only without touching other fields', () => {
    const updated = applyOperation(withMarker(), {
      kind: 'updateMarker',
      id: 'tempo00001',
      patch: { tempo_bpm: 140 },
    })
    const m = updated.markers![0]
    expect(m.tempo_bpm).toBe(140)
    expect(m.tempo_text).toBe('Allegro')
    expect(m.measureIdx).toBe(1)
  })

  it('clears tempo_text with patch.tempo_text: null', () => {
    const updated = applyOperation(withMarker(), {
      kind: 'updateMarker',
      id: 'tempo00001',
      patch: { tempo_text: null },
    })
    expect(updated.markers![0]).not.toHaveProperty('tempo_text')
    // tempo_bpm preserved so the marker still has at least one field.
    expect(updated.markers![0].tempo_bpm).toBe(120)
  })

  it('re-anchors measureIdx', () => {
    const updated = applyOperation(withMarker(), {
      kind: 'updateMarker',
      id: 'tempo00001',
      patch: { measureIdx: 0 },
    })
    expect(updated.markers![0].measureIdx).toBe(0)
  })

  it('adds metricModulation to an existing tempo marker', () => {
    const updated = applyOperation(withMarker(), {
      kind: 'updateMarker',
      id: 'tempo00001',
      patch: { metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' } },
    })
    expect(updated.markers![0].metricModulation).toEqual({
      fromNote: 'quarter',
      toNote: 'dotted-quarter',
    })
  })

  it('throws EditError when patch would leave no active fields (use removeMarker instead)', () => {
    // Clear both tempo_bpm and tempo_text — nothing left.
    expect(() =>
      applyOperation(withMarker(), {
        kind: 'updateMarker',
        id: 'tempo00001',
        patch: { tempo_bpm: null, tempo_text: null },
      }),
    ).toThrow(/no active fields/i)
  })

  it('throws EditError when id is not found', () => {
    expect(() =>
      applyOperation(withMarker(), {
        kind: 'updateMarker',
        id: 'absent000',
        patch: { tempo_bpm: 100 },
      }),
    ).toThrow(EditError)
  })

  it('throws EditError when measureIdx patch is out of range', () => {
    expect(() =>
      applyOperation(withMarker(), {
        kind: 'updateMarker',
        id: 'tempo00001',
        patch: { measureIdx: 99 },
      }),
    ).toThrow(/out of range/)
  })
})
