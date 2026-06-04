import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const BASE_SCORE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'e0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: 'e1', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { id: 'e2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'e3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const CANDIDATE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'e0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: 'e1', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'e2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'e3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

function freshStore() {
  useChatStore.setState({
    chatId: 'chat-1',
    abc: 'X:1\nK:C\nC2D2E2F2|',
    scoreJson: BASE_SCORE,
    editedScore: BASE_SCORE,
    pendingProposal: undefined,
    interruptedProposal: undefined,
    pending: false,
    history: [BASE_SCORE],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    selection: undefined,
  })
}

function publishProposal(overrides: Partial<{
  candidateVersionId: string
  affectedEventIds: string[]
}> = {}) {
  useChatStore.getState().setPendingProposal({
    chatId: 'chat-1',
    candidateVersionId: overrides.candidateVersionId ?? 'cand-1',
    candidateScore: CANDIDATE,
    beforeScore: BASE_SCORE,
    abc: 'X:1\nK:C\nC E E F|',
    affectedEventIds: overrides.affectedEventIds ?? ['e1'],
    introText: 'Raised the second note.',
    toolUseId: 'tool-1',
    headVersionId: 'head-1',
  })
}

describe('interruptedProposal slot (M24-PR-5)', () => {
  beforeEach(freshStore)

  it('starts undefined', () => {
    expect(useChatStore.getState().interruptedProposal).toBeUndefined()
  })

  it('clearInterruptedProposal drops the slot', () => {
    publishProposal()
    // Manually move to interrupted for the test.
    const slot = useChatStore.getState().pendingProposal!
    useChatStore.setState({
      pendingProposal: undefined,
      interruptedProposal: slot,
    })
    expect(useChatStore.getState().interruptedProposal).toBeDefined()
    useChatStore.getState().clearInterruptedProposal()
    expect(useChatStore.getState().interruptedProposal).toBeUndefined()
  })

  it('resumeInterruptedProposal moves it back to pendingProposal + clears interrupted', () => {
    publishProposal()
    const slot = useChatStore.getState().pendingProposal!
    useChatStore.setState({
      pendingProposal: undefined,
      interruptedProposal: slot,
    })

    useChatStore.getState().resumeInterruptedProposal()

    const s = useChatStore.getState()
    expect(s.interruptedProposal).toBeUndefined()
    expect(s.pendingProposal).toEqual(slot)
  })

  it('resumeInterruptedProposal is a no-op when nothing was interrupted', () => {
    useChatStore.getState().resumeInterruptedProposal()
    const s = useChatStore.getState()
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toBeUndefined()
  })

  it('applyEdit interrupts a pending proposal AND completes the edit', () => {
    publishProposal()
    const proposalBefore = useChatStore.getState().pendingProposal!

    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })

    const s = useChatStore.getState()
    // Edit landed.
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('D')
    // Proposal moved to interrupted slot.
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toEqual(proposalBefore)
  })

  it('applyScore interrupts a pending proposal AND completes the swap', () => {
    publishProposal()
    const proposalBefore = useChatStore.getState().pendingProposal!

    const newScore: Score = {
      ...BASE_SCORE,
      measures: [
        {
          events: [
            { id: 'newevent', pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
    }
    useChatStore.getState().applyScore(newScore)

    const s = useChatStore.getState()
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('G')
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toEqual(proposalBefore)
  })

  it('undo interrupts a pending proposal AND completes the undo', () => {
    // Build a 2-entry history so undo has somewhere to go.
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    publishProposal({ candidateVersionId: 'cand-after-edit' })
    const proposalBefore = useChatStore.getState().pendingProposal!
    expect(useChatStore.getState().historyPointer).toBeGreaterThanOrEqual(1)

    useChatStore.getState().undo()

    const s = useChatStore.getState()
    // Undo happened: pointer moved back, score is back at C.
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('C')
    // Interrupted.
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toEqual(proposalBefore)
  })

  it('redo interrupts a pending proposal AND completes the redo', () => {
    // Build edit + undo so redo has something to redo.
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    useChatStore.getState().undo()
    publishProposal({ candidateVersionId: 'cand-after-undo' })
    const proposalBefore = useChatStore.getState().pendingProposal!

    useChatStore.getState().redo()

    const s = useChatStore.getState()
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('D')
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toEqual(proposalBefore)
  })

  it('resetEditsToLLM interrupts a pending proposal AND completes the reset', () => {
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    publishProposal({ candidateVersionId: 'cand-after-edit' })
    const proposalBefore = useChatStore.getState().pendingProposal!

    useChatStore.getState().resetEditsToLLM()

    const s = useChatStore.getState()
    // Score back to baseline.
    expect(s.editedScore).toEqual(BASE_SCORE)
    // History collapsed to single entry.
    expect(s.history).toEqual([BASE_SCORE])
    expect(s.historyPointer).toBe(0)
    // Interrupted.
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toEqual(proposalBefore)
  })

  it('resolveImport interrupts a pending proposal AND completes the import', () => {
    publishProposal()
    const proposalBefore = useChatStore.getState().pendingProposal!

    const importedScore: Score = {
      title: 'imported',
      key: 'G',
      meter: '3/4',
      measures: [
        {
          events: [
            { id: 'imported1', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    useChatStore.getState().resolveImport({
      chatId: 'chat-imported',
      abc: 'X:1\nK:G\nM:3/4\nG2|',
      scoreJson: importedScore,
      importFormat: 'abc',
    })

    const s = useChatStore.getState()
    expect(s.editedScore).toEqual(importedScore)
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toEqual(proposalBefore)
  })

  it('acceptPendingProposal does NOT route through the interrupt path', () => {
    publishProposal()

    useChatStore.getState().acceptPendingProposal()

    const s = useChatStore.getState()
    // Slot cleared (accepted, not interrupted).
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toBeUndefined()
    // Score swapped to candidate.
    expect(s.editedScore).toEqual(CANDIDATE)
  })

  it('rejectPendingProposal does NOT route through the interrupt path', () => {
    publishProposal()

    useChatStore.getState().rejectPendingProposal()

    const s = useChatStore.getState()
    expect(s.pendingProposal).toBeUndefined()
    expect(s.interruptedProposal).toBeUndefined()
  })

  it('a SECOND interrupt replaces the prior interrupted slot (does not stack)', () => {
    // First publish + interrupt.
    publishProposal({ candidateVersionId: 'cand-A' })
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(useChatStore.getState().interruptedProposal?.candidateVersionId).toBe('cand-A')

    // Second publish + interrupt.
    publishProposal({ candidateVersionId: 'cand-B' })
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })

    expect(useChatStore.getState().interruptedProposal?.candidateVersionId).toBe('cand-B')
  })
})
