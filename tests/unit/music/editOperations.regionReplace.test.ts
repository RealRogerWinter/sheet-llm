import { describe, expect, it } from 'vitest'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import type { Measure, Score } from '@/lib/music/types'

/**
 * Focused regression tests for the regionReplace op (M3.5-PR-3 B2 fix
 * and friends). The general structural-op tests live in
 * editOperations.appendMeasures.test.ts; this file covers edge cases
 * that the BLOCKER review surfaced.
 */

function makeWholeBar(step: 'C' | 'D' | 'E' | 'F' | 'G'): Measure {
  return { events: [{ pitches: [{ step, octave: 4 }], duration: 'whole' }] }
}

function makeScore(measures: Measure[]): Score {
  return {
    title: 'Test',
    key: 'C',
    meter: '4/4',
    measures,
  }
}

describe('editOperations: regionReplace — isFinalPartial transfer (B2)', () => {
  it('transfers isFinalPartial to new last measure when replacing the final bar', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      { ...makeWholeBar('E'), isFinalPartial: true },
    ])
    const replacement: Measure[] = [makeWholeBar('F'), makeWholeBar('G')]
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 2,
      endMeasureIdx: 2,
      measures: replacement,
    }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(4)
    expect(next.measures[3].isFinalPartial).toBe(true)
    expect(next.measures[2].isFinalPartial).toBeUndefined()
    validateScore(next)
  })

  it('transfers isFinalPartial when replacement spans multiple bars including the final', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      makeWholeBar('E'),
      { ...makeWholeBar('F'), isFinalPartial: true },
    ])
    const replacement: Measure[] = [makeWholeBar('G')]
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 1,
      endMeasureIdx: 3,
      measures: replacement,
    }
    const next = transformScore(score, op)
    expect(next.measures).toHaveLength(2)
    expect(next.measures[1].isFinalPartial).toBe(true)
  })

  it('does NOT touch isFinalPartial when replacement ends before the final bar', () => {
    const score = makeScore([
      makeWholeBar('C'),
      makeWholeBar('D'),
      { ...makeWholeBar('E'), isFinalPartial: true },
    ])
    const replacement: Measure[] = [makeWholeBar('G')]
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 0,
      endMeasureIdx: 1,
      measures: replacement,
    }
    const next = transformScore(score, op)
    // Original final bar at original idx 2 → new idx 1 (replaced 2 bars
    // with 1). The flag stays on it.
    expect(next.measures).toHaveLength(2)
    expect(next.measures[1].isFinalPartial).toBe(true)
    // The replacement at index 0 should NOT have inherited the flag.
    expect(next.measures[0].isFinalPartial).toBeUndefined()
  })

  it('does nothing extra when original final bar had no isFinalPartial', () => {
    const score = makeScore([makeWholeBar('C'), makeWholeBar('D')])
    const replacement: Measure[] = [makeWholeBar('G')]
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 1,
      endMeasureIdx: 1,
      measures: replacement,
    }
    const next = transformScore(score, op)
    expect(next.measures[next.measures.length - 1].isFinalPartial).toBeUndefined()
  })

  it('transfers isFinalPartial on all voices when grand staff replaces the final bar', () => {
    const score: Score = {
      title: 'Grand',
      key: 'C',
      meter: '4/4',
      measures: [makeWholeBar('C'), { ...makeWholeBar('D'), isFinalPartial: true }],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          {
            events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }],
            isFinalPartial: true,
          },
        ],
      },
    }
    const op: Operation = {
      kind: 'regionReplace',
      startMeasureIdx: 1,
      endMeasureIdx: 1,
      measures: [makeWholeBar('E')],
    }
    const next = transformScore(score, op)
    expect(next.measures[1].isFinalPartial).toBe(true)
    expect(next.secondStaff!.measures[1].isFinalPartial).toBe(true)
  })
})
