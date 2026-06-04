import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const SCORE: Score = {
  title: 'epoch test',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
  ]}],
}

function reset() {
  useChatStore.setState({
    chatId: undefined,
    abc: undefined,
    scoreJson: undefined,
    editedScore: undefined,
    editMap: undefined,
    selection: undefined,
    lastPrompt: undefined,
    introText: undefined,
    pending: false,
    error: undefined,
    history: [],
    historyPointer: -1,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    epoch: 0,
  })
}

describe('useChatStore — epoch', () => {
  beforeEach(reset)

  it('starts at 0', () => {
    expect(useChatStore.getState().epoch).toBe(0)
  })

  it('increments on resolveRequest with a scoreJson', () => {
    useChatStore.getState().resolveRequest('X:1\nK:C\n', SCORE)
    expect(useChatStore.getState().epoch).toBe(1)
    useChatStore.getState().resolveRequest('X:1\nK:C\n', SCORE)
    expect(useChatStore.getState().epoch).toBe(2)
  })

  it('increments on resolveRequest even when no scoreJson', () => {
    useChatStore.getState().resolveRequest('text only')
    expect(useChatStore.getState().epoch).toBe(1)
  })

  it('does NOT increment on applyEdit', () => {
    useChatStore.getState().resolveRequest('X:1\nK:C\n', SCORE)
    const before = useChatStore.getState().epoch
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(useChatStore.getState().epoch).toBe(before)
  })

  it('does NOT increment on applyScore', () => {
    useChatStore.getState().resolveRequest('X:1\nK:C\n', SCORE)
    const before = useChatStore.getState().epoch
    useChatStore.getState().applyScore({
      ...SCORE,
      title: 'mutated',
    })
    expect(useChatStore.getState().epoch).toBe(before)
  })

  it('does NOT increment on undo/redo', () => {
    useChatStore.getState().resolveRequest('X:1\nK:C\n', SCORE)
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    const before = useChatStore.getState().epoch
    useChatStore.getState().undo()
    expect(useChatStore.getState().epoch).toBe(before)
    useChatStore.getState().redo()
    expect(useChatStore.getState().epoch).toBe(before)
  })

  it('does NOT increment on resetEditsToLLM', () => {
    useChatStore.getState().resolveRequest('X:1\nK:C\n', SCORE)
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    const before = useChatStore.getState().epoch
    useChatStore.getState().resetEditsToLLM()
    expect(useChatStore.getState().epoch).toBe(before)
  })
})
