import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

/**
 * Tests for the M19-PR-6 measureRangeSelection store slot, its
 * setters (selectMeasureRange / extendMeasureRangeTo), and its
 * pruning across applyEdit / undo / redo / applyScore.
 */

function wholeBar(step: 'C' | 'D' | 'E' | 'F' | 'G'): Score['measures'][number] {
  return { events: [{ pitches: [{ step, octave: 4 }], duration: 'whole' }] }
}

const SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    wholeBar('C'),
    wholeBar('D'),
    wholeBar('E'),
    wholeBar('F'),
    wholeBar('G'),
  ],
}

function seed() {
  useChatStore.setState({
    chatId: 'test',
    abc: 'X:1\n',
    scoreJson: SCORE,
    editedScore: SCORE,
    editMap: undefined,
    selection: undefined,
    measureRangeSelection: undefined,
    history: [SCORE],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    pending: false,
    error: undefined,
  })
}

describe('selectMeasureRange', () => {
  beforeEach(seed)

  it('sets a single-bar range', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 2, fromEnd: 2 })
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 2, fromEnd: 2 })
  })

  it('sets a multi-bar range', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 3 })
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 3 })
  })

  it('normalizes reversed endpoints (fromStart > fromEnd is swapped)', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 4, fromEnd: 1 })
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 4 })
  })

  it('clamps out-of-bounds endpoints to the valid range', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: -2, fromEnd: 99 })
    expect(useChatStore.getState().measureRangeSelection).toEqual({
      fromStart: 0,
      fromEnd: 4,
    })
  })

  it('clears with undefined', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    expect(useChatStore.getState().measureRangeSelection).toBeDefined()
    useChatStore.getState().selectMeasureRange(undefined)
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
  })

  it('clears when score is empty', () => {
    useChatStore.setState({ editedScore: undefined })
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
  })
})

describe('extendMeasureRangeTo', () => {
  beforeEach(seed)

  it('seeds a single-bar range when none exists', () => {
    useChatStore.getState().extendMeasureRangeTo(3)
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 3, fromEnd: 3 })
  })

  it('extends an existing range forward', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    useChatStore.getState().extendMeasureRangeTo(3)
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 3 })
  })

  it('extends an existing range backward', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 3, fromEnd: 3 })
    useChatStore.getState().extendMeasureRangeTo(1)
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 3 })
  })

  it('extends a multi-bar range to a measure outside its current span', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    useChatStore.getState().extendMeasureRangeTo(4)
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 4 })
  })

  it('no-ops when the measureIdx is already inside the range', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 4 })
    useChatStore.getState().extendMeasureRangeTo(2)
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 4 })
  })

  it('rejects out-of-bounds measureIdx', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    useChatStore.getState().extendMeasureRangeTo(99)
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 2 })
  })
})

describe('pruneMeasureRangeSelection — wired into mutators', () => {
  beforeEach(seed)

  it('keeps the range when the post-edit score still contains both endpoints', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    // changePitch doesn't change measure count.
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 2 })
  })

  it('clamps fromEnd when the score shrinks past the original endpoint', () => {
    // 5-bar score, range covers bars 2..4. Delete bars 3..4 via
    // dragMeasureRange → score has 3 bars. Range fromEnd=4 clamps
    // to 2 (now the last bar). fromStart=2 stays.
    useChatStore.getState().selectMeasureRange({ fromStart: 2, fromEnd: 4 })
    useChatStore.getState().applyEdit({
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 3,
      fromEnd: 4,
    })
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(3)
    expect(useChatStore.getState().measureRangeSelection).toEqual({
      fromStart: 2,
      fromEnd: 2,
    })
  })

  it('drops the range when fromStart goes out of bounds after a shrink', () => {
    // Range covers bars 3..4. Delete bars 2..4 → score has 2 bars
    // [0, 1]. fromStart=3 is OOB → drop entirely.
    useChatStore.getState().selectMeasureRange({ fromStart: 3, fromEnd: 4 })
    useChatStore.getState().applyEdit({
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 2,
      fromEnd: 4,
    })
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(2)
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
  })

  it('undo restores the range as it was pruned (no resurrection)', () => {
    // Range covers bar 4. Delete bar 4 → range drops. Undo → bar 4
    // is back but range stays undefined (we don't rewind the pruning).
    useChatStore.getState().selectMeasureRange({ fromStart: 4, fromEnd: 4 })
    useChatStore.getState().applyEdit({
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: 4,
      fromEnd: 4,
    })
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
    useChatStore.getState().undo()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(5)
    // After undo, the range remains undefined — pruning is one-way.
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
  })
})
