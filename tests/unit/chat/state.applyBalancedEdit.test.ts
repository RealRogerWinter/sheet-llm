import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const FOUR_QUARTERS_TWO_BARS: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
    { events: [
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

const ONE_NOTE_PER_BAR: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
  ],
}

function seed(score: Score) {
  useChatStore.setState({
    editedScore: score,
    scoreJson: score,
    history: [score],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    statusMessage: undefined,
    error: undefined,
  })
}

describe('applyBalancedEdit', () => {
  beforeEach(() => seed(FOUR_QUARTERS_TWO_BARS))
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BALANCED_EDITS
  })

  it('happy path: cross-barline reorder produces a valid score and bumps history', () => {
    const before = useChatStore.getState()
    useChatStore.getState().applyBalancedEdit(
      {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 3 }, // F in m0
        target: { measureIdx: 1, position32nds: 0 }, // front of m1
      },
      'test-key',
    )
    const after = useChatStore.getState()
    expect(after.editedScore).not.toBe(before.editedScore)
    expect(after.history).toHaveLength(2)
    expect(after.historyPointer).toBe(1)
    expect(after.statusMessage).toBeUndefined()
    // F moved from m0 to m1; m0 now has a quarter rest at idx 3
    const m0 = after.editedScore!.measures[0].events
    const m1 = after.editedScore!.measures[1].events
    expect(m0[3].pitches[0].step).toBe('rest')
    expect(m1[0].pitches[0].step).toBe('F')
  })

  it('would_empty_measure: leaves score unchanged and sets statusMessage', () => {
    seed(ONE_NOTE_PER_BAR)
    const before = useChatStore.getState().editedScore
    useChatStore.getState().applyBalancedEdit({
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    const after = useChatStore.getState()
    expect(after.editedScore).toBe(before)
    expect(after.history).toHaveLength(1) // no growth
    expect(after.statusMessage).toMatch(/only note/)
  })

  it('kill switch (NEXT_PUBLIC_BALANCED_EDITS=off): no-op', () => {
    process.env.NEXT_PUBLIC_BALANCED_EDITS = 'off'
    const before = useChatStore.getState().editedScore
    useChatStore.getState().applyBalancedEdit({
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 3 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    const after = useChatStore.getState()
    expect(after.editedScore).toBe(before)
    expect(after.history).toHaveLength(1)
    expect(after.statusMessage).toBeUndefined()
  })

  it('coalesces successive edits with the same key (within window)', () => {
    useChatStore.getState().applyBalancedEdit(
      {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 3 },
        target: { measureIdx: 1, position32nds: 0 },
      },
      'drag-1',
    )
    expect(useChatStore.getState().history).toHaveLength(2)
    // Same key → coalesce (replace top of history rather than push).
    useChatStore.getState().applyBalancedEdit(
      {
        kind: 'reorderBalanced',
        selection: { measureIdx: 1, eventIdx: 0 }, // F (now at m1[0])
        target: { measureIdx: 0, position32nds: 32 },
      },
      'drag-1',
    )
    expect(useChatStore.getState().history).toHaveLength(2)
  })

  it('different coalesceKey pushes a new history entry', () => {
    useChatStore.getState().applyBalancedEdit(
      {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 3 },
        target: { measureIdx: 1, position32nds: 0 },
      },
      'drag-A',
    )
    useChatStore.getState().applyBalancedEdit(
      {
        kind: 'reorderBalanced',
        selection: { measureIdx: 1, eventIdx: 0 },
        target: { measureIdx: 0, position32nds: 32 },
      },
      'drag-B',
    )
    expect(useChatStore.getState().history).toHaveLength(3)
  })

  it('sets a human-readable undoToast label', () => {
    useChatStore.getState().applyBalancedEdit({
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 3 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    const t = useChatStore.getState().undoToast
    expect(t?.label).toBe('Moved note')
  })
})
