import { describe, expect, it } from 'vitest'
import { transformScore, EditError, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import type { Measure, Score, Staff } from '@/lib/music/types'

/**
 * dragMeasureRange (M19-PR-2). Covers DELETE + MOVE modes. The op
 * backs the editor's drag-and-drop measure interaction (UI lands in
 * a subsequent PR). DUPLICATE mode lands in M19-PR-3.
 */

function makeWholeBar(step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', octave = 4): Measure {
  return { events: [{ pitches: [{ step, octave }], duration: 'whole' }] }
}

function makeWholeBarWithId(
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B',
  id: string,
  octave = 4,
): Measure {
  return {
    events: [
      { id, pitches: [{ step, octave }], duration: 'whole' },
    ],
  }
}

function makeScore(measures: Measure[], extra: Partial<Score> = {}): Score {
  return {
    title: 'Test',
    key: 'C',
    meter: '4/4',
    measures,
    ...extra,
  }
}

// ─────────────────────────────────────────────────────────────────────
// DELETE mode
// ─────────────────────────────────────────────────────────────────────

describe('dragMeasureRange — delete', () => {
  it('removes a single measure', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 1,
      fromEnd: 1,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'E',
      'F',
    ])
    validateScore(next)
  })

  it('removes a contiguous range', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
      makeWholeBar('G'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 1,
      fromEnd: 3,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'G',
    ])
    validateScore(next)
  })

  it('preserves cross-staff bar alignment', () => {
    const secondStaff: Staff = {
      clef: 'bass',
      measures: [
        makeWholeBar('C', 3),
        makeWholeBar('D', 3),
        makeWholeBar('E', 3),
        makeWholeBar('F', 3),
      ],
    }
    const score = makeScore(
      [makeWholeBar('C'), makeWholeBar('D'), makeWholeBar('E'), makeWholeBar('F')],
      { secondStaff },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 1,
      fromEnd: 2,
    }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(2)
    expect(next.secondStaff?.measures).toHaveLength(2)
    expect(next.secondStaff?.measures[0].events[0].pitches[0].step).toBe('C')
    expect(next.secondStaff?.measures[1].events[0].pitches[0].step).toBe('F')
    validateScore(next)
  })

  it('drops markers inside the deleted range and remaps later ones', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
      ],
      {
        markers: [
          { id: 'marker0001', measureIdx: 0, tempo_bpm: 100 },
          // Inside the deleted range — drops.
          { id: 'marker0002', measureIdx: 2, tempo_bpm: 200 },
          // After the deleted range — remaps.
          { id: 'marker0003', measureIdx: 3, key: 'G' },
        ],
      },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 1,
      fromEnd: 2,
    }
    const next = transformScore(score, op)
    const ids = (next.markers ?? []).map((m) => m.id)
    expect(ids).toEqual(['marker0001', 'marker0003'])
    expect(next.markers?.find((m) => m.id === 'marker0001')?.measureIdx).toBe(0)
    expect(next.markers?.find((m) => m.id === 'marker0003')?.measureIdx).toBe(1)
    validateScore(next)
  })

  it('drops spans fully inside the deleted range + severed spans', () => {
    const score = makeScore(
      [
        makeWholeBarWithId('C', 'evtA0001'),
        makeWholeBarWithId('D', 'evtB0001'),
        makeWholeBarWithId('E', 'evtC0001'),
        makeWholeBarWithId('F', 'evtD0001'),
      ],
      {
        spans: [
          // Fully inside [1..2] → drops.
          {
            id: 'span0001',
            kind: 'slur',
            startEventId: 'evtB0001',
            endEventId: 'evtC0001',
            staffIdx: 0,
            voiceIdx: 0,
          },
          // Severed (start outside, end inside) → drops.
          {
            id: 'span0002',
            kind: 'slur',
            startEventId: 'evtA0001',
            endEventId: 'evtC0001',
            staffIdx: 0,
            voiceIdx: 0,
          },
          // Fully outside [1..2] → preserved.
          {
            id: 'span0003',
            kind: 'slur',
            startEventId: 'evtA0001',
            endEventId: 'evtD0001',
            staffIdx: 0,
            voiceIdx: 0,
          },
        ],
      },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 1,
      fromEnd: 2,
    }
    const next = transformScore(score, op)
    // Only span0003 survives (its endpoints — evt-A in measure 0 and
    // evt-D in measure 3 — are both outside the deleted range).
    expect((next.spans ?? []).map((s) => s.id)).toEqual(['span0003'])
    validateScore(next)
  })

  it('drops voltas inside the deleted range and preserves outside ones', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
        makeWholeBar('G'),
      ],
      {
        voltas: [
          // Fully inside [1..2] → drops.
          {
            id: 'volta001',
            startMeasureIdx: 1,
            endMeasureIdx: 2,
            endings: [1],
          },
          // Outside → preserved, remapped.
          {
            id: 'volta002',
            startMeasureIdx: 3,
            endMeasureIdx: 4,
            endings: [2],
          },
        ],
      },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 1,
      fromEnd: 2,
    }
    const next = transformScore(score, op)
    expect((next.voltas ?? []).map((v) => v.id)).toEqual(['volta002'])
    expect(next.voltas?.[0].startMeasureIdx).toBe(1)
    expect(next.voltas?.[0].endMeasureIdx).toBe(2)
    validateScore(next)
  })

  it('rejects a delete that would empty the score', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 0,
      fromEnd: 1,
    }
    expect(() => transformScore(score, op)).toThrow(EditError)
    expect(() => transformScore(score, op)).toThrow(/empty/)
  })

  it('rejects fromStart < 0', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: -1,
      fromEnd: 0,
    }
    expect(() => transformScore(score, op)).toThrow(/invalid/)
  })

  it('rejects fromEnd >= measureCount', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 0,
      fromEnd: 5,
    }
    expect(() => transformScore(score, op)).toThrow(/invalid/)
  })

  it('rejects fromStart > fromEnd', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 2,
      fromEnd: 1,
    }
    expect(() => transformScore(score, op)).toThrow(/invalid/)
  })

  it('transfers isFinalPartial to the new last bar when the deleted range includes the original final bar', () => {
    // Code-review MUST FIX (M19-PR-2): applyRegionReplace's
    // transferFinalPartial gate is `newCount > 0`, so the empty-
    // replacement path used by delete skips the transfer entirely.
    // Without normalizeFinalPartial, deleting the final bar would
    // leave the new last bar without the flag.
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      { ...makeWholeBar('F'), isFinalPartial: true },
    ])
    // Delete the final bar.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 3,
      fromEnd: 3,
    }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(3)
    // E (the new last bar) inherits the flag.
    expect(next.measures[2].isFinalPartial).toBe(true)
    validateScore(next)
  })

  it('drops jumpMarkers + segno + coda inside the range and their dangling refs', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
      ],
      {
        segnoMarkers: [{ id: 'segno0001', measureIdx: 2, side: 'start' }],
        jumpMarkers: [
          {
            id: 'jump00001',
            measureIdx: 3,
            side: 'end',
            kind: 'D.S.',
            segnoRef: 'segno0001',
          },
        ],
      },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 2,
      fromEnd: 2,
    }
    const next = transformScore(score, op)
    // Segno at measure 2 dropped (inside deleted range); jumpMarker's
    // segnoRef now dangles → also dropped by remapScoreReferences H3.
    expect(next.segnoMarkers).toBeUndefined()
    expect(next.jumpMarkers).toBeUndefined()
    validateScore(next)
  })
})

// ─────────────────────────────────────────────────────────────────────
// MOVE mode
// ─────────────────────────────────────────────────────────────────────

describe('dragMeasureRange — move', () => {
  it('moves a single bar forward', () => {
    // Bars [C, D, E, F] → move bar 1 (D) to after bar 3 (F).
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 1,
      fromEnd: 1,
      toAfter: 3,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'E',
      'F',
      'D',
    ])
    validateScore(next)
  })

  it('moves a single bar backward', () => {
    // Bars [C, D, E, F, G] → move bar 4 (G) to after bar 0 (C).
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
      makeWholeBar('G'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 4,
      fromEnd: 4,
      toAfter: 0,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'G',
      'D',
      'E',
      'F',
    ])
    validateScore(next)
  })

  it('moves a contiguous range backward', () => {
    // Bars [C, D, E, F, G] → move bars 2-3 (E, F) to after bar 0 (C).
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
      makeWholeBar('G'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: 0,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'E',
      'F',
      'D',
      'G',
    ])
    validateScore(next)
  })

  it('moves a range to the very start with toAfter=-1', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: -1,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'E',
      'F',
      'C',
      'D',
    ])
    validateScore(next)
  })

  it('preserves cross-staff alignment when moving (second staff comes along)', () => {
    const secondStaff: Staff = {
      clef: 'bass',
      measures: [
        makeWholeBar('C', 3),
        makeWholeBar('D', 3),
        makeWholeBar('E', 3),
        makeWholeBar('F', 3),
      ],
    }
    const score = makeScore(
      [makeWholeBar('C'), makeWholeBar('D'), makeWholeBar('E'), makeWholeBar('F')],
      { secondStaff },
    )
    // Move bars 0-1 to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 0,
      fromEnd: 1,
      toAfter: 3,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'E',
      'F',
      'C',
      'D',
    ])
    expect(
      next.secondStaff?.measures.map((m) => m.events[0].pitches[0].step),
    ).toEqual(['E', 'F', 'C', 'D'])
    expect(next.secondStaff?.measures.map((m) => m.events[0].pitches[0].octave)).toEqual([
      3,
      3,
      3,
      3,
    ])
    validateScore(next)
  })

  it('preserves spans whose endpoints are both inside the moved range (ids unchanged)', () => {
    // A slur on evt-B → evt-C, both inside [1..2] which we move to
    // the end. The span survives because event ids don't change.
    const score = makeScore(
      [
        makeWholeBarWithId('C', 'evtA0001'),
        makeWholeBarWithId('D', 'evtB0001'),
        makeWholeBarWithId('E', 'evtC0001'),
        makeWholeBarWithId('F', 'evtD0001'),
      ],
      {
        spans: [
          {
            id: 'span0001',
            kind: 'slur',
            startEventId: 'evtB0001',
            endEventId: 'evtC0001',
            staffIdx: 0,
            voiceIdx: 0,
          },
        ],
      },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 1,
      fromEnd: 2,
      toAfter: 3,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'F',
      'D',
      'E',
    ])
    // Span is intact and still resolvable.
    expect(next.spans).toHaveLength(1)
    expect(next.spans?.[0].startEventId).toBe('evtB0001')
    expect(next.spans?.[0].endEventId).toBe('evtC0001')
    validateScore(next)
  })

  it('moves a marker inside the range along with the range', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
        makeWholeBar('G'),
      ],
      {
        markers: [
          { id: 'marker0001', measureIdx: 2, key: 'G' },
          { id: 'marker0002', measureIdx: 4, tempo_bpm: 80 },
        ],
      },
    )
    // Move bars 2-3 to the start.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: -1,
    }
    const next = transformScore(score, op)
    // marker0001 was at index 2 → now at index 0 (moved with the range).
    // marker0002 was at index 4 → now at index 4 (its bar didn't move
    // relative to the surrounding bars; range insertion at start
    // pushes original 0,1,4 forward by 2).
    const markersById = Object.fromEntries(
      (next.markers ?? []).map((m) => [m.id, m.measureIdx] as const),
    )
    expect(markersById.marker0001).toBe(0)
    expect(markersById.marker0002).toBe(4)
    validateScore(next)
  })

  it('preserves voltas fully inside the moved range', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
        makeWholeBar('G'),
      ],
      {
        voltas: [
          { id: 'volta001', startMeasureIdx: 2, endMeasureIdx: 3, endings: [1] },
        ],
      },
    )
    // Move bars 2-3 to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: 4,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'D',
      'G',
      'E',
      'F',
    ])
    expect(next.voltas).toHaveLength(1)
    expect(next.voltas?.[0].startMeasureIdx).toBe(3)
    expect(next.voltas?.[0].endMeasureIdx).toBe(4)
    validateScore(next)
  })

  it('drops voltas that straddle the moved range', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
        makeWholeBar('G'),
      ],
      {
        voltas: [
          // Straddles [2..3] move: starts inside (2), ends outside (4).
          { id: 'volta001', startMeasureIdx: 2, endMeasureIdx: 4, endings: [1] },
          // Fully outside — preserved + remapped.
          { id: 'volta002', startMeasureIdx: 0, endMeasureIdx: 0, endings: [2] },
        ],
      },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: 4,
    }
    const next = transformScore(score, op)
    const ids = (next.voltas ?? []).map((v) => v.id)
    expect(ids).toEqual(['volta002'])
    validateScore(next)
  })

  it('preserves jumpMarkers and segno/coda inside the moved range, dangling-sweep included', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
        makeWholeBar('G'),
      ],
      {
        segnoMarkers: [{ id: 'segno0001', measureIdx: 1, side: 'start' }],
        jumpMarkers: [
          {
            id: 'jump00001',
            measureIdx: 3,
            side: 'end',
            kind: 'D.S.',
            segnoRef: 'segno0001',
          },
        ],
      },
    )
    // Move bars 3-4 to the start. The D.S. comes along; the segno
    // stays where it was (measure 1 is OUTSIDE the moved range).
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 3,
      fromEnd: 4,
      toAfter: -1,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'F',
      'G',
      'C',
      'D',
      'E',
    ])
    // segno was at original 1 → after start-insertion of 2 bars, shifts to 3.
    expect(next.segnoMarkers).toEqual([{ id: 'segno0001', measureIdx: 3, side: 'start' }])
    // D.S. was at original 3 → now at 0 (moved with the range).
    expect(next.jumpMarkers).toEqual([
      {
        id: 'jump00001',
        measureIdx: 0,
        side: 'end',
        kind: 'D.S.',
        segnoRef: 'segno0001',
      },
    ])
    validateScore(next)
  })

  it('preserves techniqueStates inside the moved range', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
      ],
      {
        techniqueStates: [
          { id: 'tech00001', measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        ],
      },
    )
    // Move bar 1 to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 1,
      fromEnd: 1,
      toAfter: 3,
    }
    const next = transformScore(score, op)
    expect(next.techniqueStates).toHaveLength(1)
    expect(next.techniqueStates?.[0].measureIdx).toBe(3)
    validateScore(next)
  })

  it('rejects move with toAfter overlapping the source range', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
    ])
    // toAfter=2 is INSIDE [1..3]. Reject.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 1,
      fromEnd: 3,
      toAfter: 2,
    }
    expect(() => transformScore(score, op)).toThrow(/overlap/)
  })

  it('rejects move with toAfter equal to fromStart-1 (no-op)', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
    ])
    // toAfter=1 means insert after bar 1 → bars 2..2 stay where they are.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 2,
      toAfter: 1,
    }
    expect(() => transformScore(score, op)).toThrow(/overlap|no-op/)
  })

  it('rejects move with toAfter out of range', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 0,
      fromEnd: 0,
      toAfter: 99,
    }
    expect(() => transformScore(score, op)).toThrow(/out of range/)
  })

  it('rejects move with toAfter < -1', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 1,
      fromEnd: 1,
      toAfter: -5,
    }
    expect(() => transformScore(score, op)).toThrow(/out of range/)
  })

  it('rejects move with invalid fromStart/fromEnd', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 5,
      fromEnd: 5,
      toAfter: 0,
    }
    expect(() => transformScore(score, op)).toThrow(/invalid/)
  })

  it('transfers isFinalPartial to the new last bar when the moved range includes the original final bar', () => {
    // Code-review MUST FIX (M19-PR-2): bars [C, D, E, F(isFinalPartial)]
    // → move bars 2-3 (E, F) to the START. After the move, the original
    // final bar F sits at index 1 (middle); D (now at index 3) is the
    // actual last bar and must carry isFinalPartial. The pre-fix bug
    // left the flag on F (now in the middle) and gave D nothing.
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      { ...makeWholeBar('F'), isFinalPartial: true },
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: -1,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'E',
      'F',
      'C',
      'D',
    ])
    // Only the actual last bar (D at idx 3) carries the flag now.
    expect(next.measures[3].isFinalPartial).toBe(true)
    expect(next.measures[0].isFinalPartial).toBeUndefined()
    expect(next.measures[1].isFinalPartial).toBeUndefined()
    expect(next.measures[2].isFinalPartial).toBeUndefined()
    validateScore(next)
  })

  it('preserves isFinalPartial on the surviving last bar when no rearrangement touches the final', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      { ...makeWholeBar('F'), isFinalPartial: true },
    ])
    // Move bar 0 to position 1 (no overlap with the final bar).
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 0,
      fromEnd: 0,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    // F stays at idx 3 (last) with the flag intact.
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'D',
      'E',
      'C',
      'F',
    ])
    expect(next.measures[3].isFinalPartial).toBe(true)
    expect(next.measures[0].isFinalPartial).toBeUndefined()
    validateScore(next)
  })

  it('preserves spans whose endpoints live on secondStaff', () => {
    // Spans on staffIdx=1 (secondStaff) — move must preserve them
    // because event ids on secondStaff stay intact across the splice.
    const secondStaff: Staff = {
      clef: 'bass',
      measures: [
        makeWholeBarWithId('C', 'ssEvt0001', 3),
        makeWholeBarWithId('D', 'ssEvt0002', 3),
        makeWholeBarWithId('E', 'ssEvt0003', 3),
        makeWholeBarWithId('F', 'ssEvt0004', 3),
      ],
    }
    const score = makeScore(
      [makeWholeBar('C'), makeWholeBar('D'), makeWholeBar('E'), makeWholeBar('F')],
      {
        secondStaff,
        spans: [
          {
            id: 'span0001',
            kind: 'slur',
            startEventId: 'ssEvt0002',
            endEventId: 'ssEvt0003',
            staffIdx: 1,
            voiceIdx: 0,
          },
        ],
      },
    )
    // Move bars 1-2 (which carry the spanned events on secondStaff) to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 1,
      fromEnd: 2,
      toAfter: 3,
    }
    const next = transformScore(score, op)
    expect(next.spans).toHaveLength(1)
    expect(next.spans?.[0].startEventId).toBe('ssEvt0002')
    expect(next.spans?.[0].endEventId).toBe('ssEvt0003')
    expect(next.spans?.[0].staffIdx).toBe(1)
    validateScore(next)
  })

  it('preserves cross-staff alignment when secondStaff has extraVoices', () => {
    const secondStaff: Staff = {
      clef: 'bass',
      measures: [
        makeWholeBar('C', 3),
        makeWholeBar('D', 3),
        makeWholeBar('E', 3),
        makeWholeBar('F', 3),
      ],
      extraVoices: [
        {
          measures: [
            makeWholeBar('G', 2),
            makeWholeBar('A', 2),
            makeWholeBar('B', 2),
            makeWholeBar('C', 3),
          ],
        },
      ],
    }
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
      ],
      {
        secondStaff,
        extraVoices: [
          {
            measures: [
              makeWholeBar('G'),
              makeWholeBar('A'),
              makeWholeBar('B'),
              makeWholeBar('C'),
            ],
          },
        ],
      },
    )
    // Move bars 0-1 to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 0,
      fromEnd: 1,
      toAfter: 3,
    }
    const next = transformScore(score, op)
    // Primary voice on primary staff.
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'E',
      'F',
      'C',
      'D',
    ])
    // Extra voice on primary staff.
    expect(
      next.extraVoices?.[0].measures.map((m) => m.events[0].pitches[0].step),
    ).toEqual(['B', 'C', 'G', 'A'])
    // Primary voice on secondStaff.
    expect(
      next.secondStaff?.measures.map((m) => m.events[0].pitches[0].step),
    ).toEqual(['E', 'F', 'C', 'D'])
    // Extra voice on secondStaff.
    expect(
      next.secondStaff?.extraVoices?.[0].measures.map(
        (m) => m.events[0].pitches[0].step,
      ),
    ).toEqual(['B', 'C', 'G', 'A'])
    validateScore(next)
  })

  it('annotations fully inside the moved range follow it; straddlers drop', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
        makeWholeBar('G'),
      ],
      {
        annotations: [
          // Fully inside [2..3] → follows.
          {
            id: 'anno0001',
            target: { measureIdx: 2, position: 'above' },
            text: 'inside',
            style: 'plain',
          },
          // Straddler — target inside, spanEnd outside. Drops.
          {
            id: 'anno0002',
            target: { measureIdx: 2, position: 'above' },
            spanEnd: { measureIdx: 4 },
            text: 'straddler',
            style: 'plain',
          },
          // Fully outside — remapped.
          {
            id: 'anno0003',
            target: { measureIdx: 0, position: 'above' },
            text: 'outside',
            style: 'plain',
          },
        ],
      },
    )
    // Move bars 2-3 to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'move',
      fromStart: 2,
      fromEnd: 3,
      toAfter: 4,
    }
    const next = transformScore(score, op)
    const ids = (next.annotations ?? []).map((a) => a.id).sort()
    // anno0001 follows the moved range. anno0002 was a straddler and
    // dropped. anno0003 stays put (remapped through outside-region
    // shift logic).
    expect(ids).toEqual(['anno0001', 'anno0003'])
    const insideAnno = next.annotations?.find((a) => a.id === 'anno0001')
    expect(insideAnno?.target.measureIdx).toBe(3)
    const outsideAnno = next.annotations?.find((a) => a.id === 'anno0003')
    expect(outsideAnno?.target.measureIdx).toBe(0)
    validateScore(next)
  })
})

// ─────────────────────────────────────────────────────────────────────
// DUPLICATE mode (M19-PR-3)
// ─────────────────────────────────────────────────────────────────────

describe('dragMeasureRange — duplicate', () => {
  it('duplicates a single bar and inserts the copy at the end', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 1,
      fromEnd: 1,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'D',
      'E',
      'D',
    ])
    validateScore(next)
  })

  it('duplicates a contiguous range to the start', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      makeWholeBar('F'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 2,
      fromEnd: 3,
      toAfter: -1,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'E',
      'F',
      'C',
      'D',
      'E',
      'F',
    ])
    validateScore(next)
  })

  it('mints fresh event ids on the duplicated measures (no id collision)', () => {
    const score = makeScore([
      makeWholeBarWithId('C', 'evtA0001'),
      makeWholeBarWithId('D', 'evtB0001'),
      makeWholeBarWithId('E', 'evtC0001'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 1,
      fromEnd: 1,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    // 4 measures total; ids must all be unique.
    const ids = next.measures.map((m) => m.events[0].id)
    expect(new Set(ids).size).toBe(4)
    // Originals preserved.
    expect(ids[0]).toBe('evtA0001')
    expect(ids[1]).toBe('evtB0001')
    expect(ids[2]).toBe('evtC0001')
    // Duplicated bar's event has a NEW id, not the original.
    expect(ids[3]).not.toBe('evtB0001')
    expect(ids[3]).toBeDefined()
    validateScore(next)
  })

  it('preserves spans (still attached to originals) when duplicating', () => {
    const score = makeScore(
      [
        makeWholeBarWithId('C', 'evtA0001'),
        makeWholeBarWithId('D', 'evtB0001'),
        makeWholeBarWithId('E', 'evtC0001'),
      ],
      {
        spans: [
          {
            id: 'span0001',
            kind: 'slur',
            startEventId: 'evtA0001',
            endEventId: 'evtB0001',
            staffIdx: 0,
            voiceIdx: 0,
          },
        ],
      },
    )
    // Duplicate bar 0 (which carries one span endpoint) to the end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 0,
      fromEnd: 0,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    // The original span still resolves; the duplicated bar has a
    // FRESH id (no second span).
    expect(next.spans).toHaveLength(1)
    expect(next.spans?.[0].startEventId).toBe('evtA0001')
    expect(next.spans?.[0].endEventId).toBe('evtB0001')
    // The duplicated bar's event id is fresh, not 'evtA0001'.
    expect(next.measures[3].events[0].id).not.toBe('evtA0001')
    validateScore(next)
  })

  it('does NOT duplicate score-level entries (markers in source stay only on originals)', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
      ],
      {
        markers: [{ id: 'marker0001', measureIdx: 1, tempo_bpm: 88 }],
      },
    )
    // Duplicate bar 1 (which has a marker) to position 2.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 1,
      fromEnd: 1,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    // Only the original marker survives; the duplicate has no marker.
    expect(next.markers).toHaveLength(1)
    expect(next.markers?.[0].id).toBe('marker0001')
    expect(next.markers?.[0].measureIdx).toBe(1)
    validateScore(next)
  })

  it('remaps OUT-of-range markers forward after duplicate insertion', () => {
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
        makeWholeBar('F'),
      ],
      {
        markers: [
          // Before duplicate insertion → stays put.
          { id: 'marker0001', measureIdx: 0, tempo_bpm: 60 },
          // After duplicate insertion → shifts forward by rangeLen.
          { id: 'marker0002', measureIdx: 3, key: 'G' },
        ],
      },
    )
    // Duplicate bars 1-2 (rangeLen=2) to position toAfter=2 (between
    // original 2 and 3). Original 3 should shift to idx 5.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 1,
      fromEnd: 2,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    const m1 = next.markers?.find((m) => m.id === 'marker0001')
    const m2 = next.markers?.find((m) => m.id === 'marker0002')
    expect(m1?.measureIdx).toBe(0)
    expect(m2?.measureIdx).toBe(5)
    validateScore(next)
  })

  it('preserves cross-staff alignment when duplicating', () => {
    const secondStaff: Staff = {
      clef: 'bass',
      measures: [
        makeWholeBar('C', 3),
        makeWholeBar('D', 3),
        makeWholeBar('E', 3),
      ],
    }
    const score = makeScore(
      [makeWholeBar('C'), makeWholeBar('D'), makeWholeBar('E')],
      { secondStaff },
    )
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 0,
      fromEnd: 1,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    // Both staves grew to 5 measures; copy of bars 0-1 lands at the end.
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'D',
      'E',
      'C',
      'D',
    ])
    expect(
      next.secondStaff?.measures.map((m) => m.events[0].pitches[0].step),
    ).toEqual(['C', 'D', 'E', 'C', 'D'])
    validateScore(next)
  })

  it('preserves cross-staff alignment when secondStaff has extraVoices', () => {
    const secondStaff: Staff = {
      clef: 'bass',
      measures: [
        makeWholeBar('C', 3),
        makeWholeBar('D', 3),
        makeWholeBar('E', 3),
      ],
      extraVoices: [
        {
          measures: [
            makeWholeBar('G', 2),
            makeWholeBar('A', 2),
            makeWholeBar('B', 2),
          ],
        },
      ],
    }
    const score = makeScore(
      [makeWholeBar('C'), makeWholeBar('D'), makeWholeBar('E')],
      { secondStaff },
    )
    // Duplicate bar 0 to position 2 (end).
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 0,
      fromEnd: 0,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    expect(next.secondStaff?.extraVoices?.[0].measures).toHaveLength(4)
    expect(
      next.secondStaff?.extraVoices?.[0].measures.map(
        (m) => m.events[0].pitches[0].step,
      ),
    ).toEqual(['G', 'A', 'B', 'G'])
    validateScore(next)
  })

  it('normalizes isFinalPartial when duplicating the original final bar', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      { ...makeWholeBar('E'), isFinalPartial: true },
    ])
    // Duplicate bar 2 (the final, with isFinalPartial) to position 2 → end.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 2,
      fromEnd: 2,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'D',
      'E',
      'E',
    ])
    // Only the actual last bar (the COPY at idx 3) carries the flag;
    // the original at idx 2 is no longer last, must be cleared.
    expect(next.measures[3].isFinalPartial).toBe(true)
    expect(next.measures[2].isFinalPartial).toBeUndefined()
    validateScore(next)
  })

  it('allows toAfter inside the source range (interleaves the copy)', () => {
    // Unlike move, duplicate has no overlap restriction because the
    // source range doesn't get removed.
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
    ])
    // Duplicate bars 0-2 to position toAfter=1 (interleaves).
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 0,
      fromEnd: 2,
      toAfter: 1,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'D',
      'C',
      'D',
      'E',
      'E',
    ])
    validateScore(next)
  })

  it('rejects duplicate with toAfter out of range', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 0,
      fromEnd: 0,
      toAfter: 99,
    }
    expect(() => transformScore(score, op)).toThrow(/out of range/)
  })

  it('rejects duplicate with toAfter < -1', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 0,
      fromEnd: 0,
      toAfter: -5,
    }
    expect(() => transformScore(score, op)).toThrow(/out of range/)
  })

  it('rejects duplicate with invalid fromStart/fromEnd', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 5,
      fromEnd: 5,
      toAfter: 0,
    }
    expect(() => transformScore(score, op)).toThrow(/invalid/)
  })

  it('allows toAfter = fromStart-1 (copy lands directly before originals, two adjacent ranges)', () => {
    // Code-review SUGGEST #4: duplicate has no overlap restriction;
    // toAfter = fromStart - 1 means insertion lands directly BEFORE
    // the source range, producing `[..., 1', 2', 1, 2, ...]`.
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
    ])
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 1,
      fromEnd: 2,
      toAfter: 0,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'D',
      'E',
      'D',
      'E',
    ])
    validateScore(next)
  })

  it('does NOT duplicate score-level entries (voltas / jumpMarkers / segno / coda / techniqueStates / annotations)', () => {
    // Code-review SUGGEST #6: the existing "no duplicate markers" test
    // only covers markers. Pin the same semantic for every other
    // score-level entry type so a future refactor that wires
    // extractRangeEntries into the duplicate path (e.g. for an
    // explicit "deep-duplicate everything" mode) doesn't quietly
    // break this contract.
    const score = makeScore(
      [
        makeWholeBar('C'),
        makeWholeBar('D'),
        makeWholeBar('E'),
      ],
      {
        markers: [{ id: 'marker0001', measureIdx: 1, tempo_bpm: 88 }],
        voltas: [
          { id: 'volta0001', startMeasureIdx: 1, endMeasureIdx: 1, endings: [1] },
        ],
        segnoMarkers: [{ id: 'segno0001', measureIdx: 1, side: 'start' }],
        codaMarkers: [{ id: 'coda00001', measureIdx: 1, side: 'start' }],
        jumpMarkers: [
          {
            id: 'jump00001',
            measureIdx: 1,
            side: 'end',
            kind: 'D.S.',
            segnoRef: 'segno0001',
          },
        ],
        techniqueStates: [
          { id: 'tech00001', measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        ],
        annotations: [
          {
            id: 'anno00001',
            target: { measureIdx: 1, position: 'above' },
            text: 'rehearsal A',
            style: 'rehearsal-mark',
          },
        ],
      },
    )
    // Duplicate bar 1 (the bar carrying every score-level entry above)
    // to position 2 (end). The COPY should carry no markers / voltas /
    // segno / coda / jumpMarkers / techniqueStates / annotations.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 1,
      fromEnd: 1,
      toAfter: 2,
    }
    const next = transformScore(score, op)
    // Each entry survives ONCE and stays on the original measure
    // (measureIdx 1 — pre-insertion bar; remap forward by 1 only
    // applies to entries AT OR AFTER toAfter, which is bar 2).
    expect(next.markers).toHaveLength(1)
    expect(next.markers?.[0].measureIdx).toBe(1)
    expect(next.voltas).toHaveLength(1)
    expect(next.voltas?.[0].startMeasureIdx).toBe(1)
    expect(next.voltas?.[0].endMeasureIdx).toBe(1)
    expect(next.segnoMarkers).toHaveLength(1)
    expect(next.segnoMarkers?.[0].measureIdx).toBe(1)
    expect(next.codaMarkers).toHaveLength(1)
    expect(next.codaMarkers?.[0].measureIdx).toBe(1)
    expect(next.jumpMarkers).toHaveLength(1)
    expect(next.jumpMarkers?.[0].measureIdx).toBe(1)
    expect(next.techniqueStates).toHaveLength(1)
    expect(next.techniqueStates?.[0].measureIdx).toBe(1)
    expect(next.annotations).toHaveLength(1)
    expect(next.annotations?.[0].target.measureIdx).toBe(1)
    validateScore(next)
  })

  it('normalizes isFinalPartial when duplicating the original final bar to a MIDDLE position', () => {
    // Code-review SUGGEST #7: covered duplicate-final-to-end already.
    // Pin the duplicate-final-to-middle case: the COPY lands in the
    // middle with isFinalPartial still on it from the raw clone, but
    // normalizeFinalPartial must strip it (only the actual last bar
    // — the original at idx 3 — should keep the flag).
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      { ...makeWholeBar('E'), isFinalPartial: true },
    ])
    // Duplicate bar 2 (the final, with isFinalPartial) to position 0
    // → copy lands at idx 1; original stays at idx 3.
    const op: Operation = {
      kind: 'dragMeasureRange',
      mode: 'duplicate',
      fromStart: 2,
      fromEnd: 2,
      toAfter: 0,
    }
    const next = transformScore(score, op)
    expect(next.measures.map((m) => m.events[0].pitches[0].step)).toEqual([
      'C',
      'E',
      'D',
      'E',
    ])
    // Original E at idx 3 keeps the flag (it's now the actual last).
    expect(next.measures[3].isFinalPartial).toBe(true)
    // The COPY at idx 1 is NOT last — must have the flag stripped.
    expect(next.measures[1].isFinalPartial).toBeUndefined()
    expect(next.measures[0].isFinalPartial).toBeUndefined()
    expect(next.measures[2].isFinalPartial).toBeUndefined()
    validateScore(next)
  })
})
