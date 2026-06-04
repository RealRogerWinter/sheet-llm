import { describe, it, expect, beforeEach } from 'vitest'
import {
  useChatStore,
  computeProposalPresentation,
  GHOST_PREVIEW_INLINE_THRESHOLD,
  type PendingProposal,
} from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const BEFORE_SCORE: Score = {
  title: 'C major scale',
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

const AFTER_SCORE: Score = {
  title: 'C major scale',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        // Same C quarter at e0.
        { id: 'e0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        // e1 raised D -> E.
        { id: 'e1', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        // Unchanged.
        { id: 'e2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        // Unchanged.
        { id: 'e3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

function freshStore() {
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
    pendingProposal: undefined,
    epoch: 0,
  })
}

function seedScore(score: Score = BEFORE_SCORE): void {
  // resolveRequest is the canonical way to seat a score; mirrors the
  // pre-proposal state every realistic caller hits before publishing.
  useChatStore.getState().resolveRequest('X:1\nK:C', score, 'baseline')
}

function makeProposal(
  affectedEventIds: string[] = ['e1'],
  overrides: Partial<Omit<PendingProposal, 'presentation'>> = {},
): Omit<PendingProposal, 'presentation'> {
  return {
    chatId: 'chat-id',
    candidateVersionId: 'cand-1',
    candidateScore: AFTER_SCORE,
    beforeScore: BEFORE_SCORE,
    abc: 'X:1\nK:C\nC E E F|',
    affectedEventIds,
    introText: 'Raised the second note to E.',
    toolUseId: 'tool-1',
    headVersionId: 'head-1',
    ...overrides,
  }
}

describe('computeProposalPresentation', () => {
  it('inline at threshold (4 events)', () => {
    expect(computeProposalPresentation(['a', 'b', 'c', 'd'])).toBe('inline')
  })

  it('diff-panel one above threshold (5 events)', () => {
    expect(computeProposalPresentation(['a', 'b', 'c', 'd', 'e'])).toBe(
      'diff-panel',
    )
  })

  it('inline for the empty set (no-op proposal)', () => {
    expect(computeProposalPresentation([])).toBe('inline')
  })

  it('threshold constant is 4', () => {
    // Pinning the value so PR-3/PR-4 layout assumptions don't drift
    // out from under us silently. Bump this AND the layout when you
    // bump the threshold.
    expect(GHOST_PREVIEW_INLINE_THRESHOLD).toBe(4)
  })
})

describe('useChatStore — pendingProposal slot', () => {
  beforeEach(freshStore)

  it('starts undefined', () => {
    expect(useChatStore.getState().pendingProposal).toBeUndefined()
  })

  it('setPendingProposal stores the slot and auto-computes inline presentation', () => {
    useChatStore.getState().setPendingProposal(makeProposal(['e1']))
    const slot = useChatStore.getState().pendingProposal
    expect(slot).toBeDefined()
    expect(slot!.candidateVersionId).toBe('cand-1')
    expect(slot!.affectedEventIds).toEqual(['e1'])
    expect(slot!.presentation).toBe('inline')
    expect(slot!.candidateScore).toBe(AFTER_SCORE)
    expect(slot!.beforeScore).toBe(BEFORE_SCORE)
    expect(slot!.introText).toBe('Raised the second note to E.')
    expect(slot!.headVersionId).toBe('head-1')
  })

  it('setPendingProposal computes diff-panel for >4 events', () => {
    useChatStore.getState().setPendingProposal(
      makeProposal(['a', 'b', 'c', 'd', 'e']),
    )
    expect(useChatStore.getState().pendingProposal!.presentation).toBe(
      'diff-panel',
    )
  })

  it('setPendingProposal(undefined) clears the slot', () => {
    useChatStore.getState().setPendingProposal(makeProposal())
    expect(useChatStore.getState().pendingProposal).toBeDefined()
    useChatStore.getState().setPendingProposal(undefined)
    expect(useChatStore.getState().pendingProposal).toBeUndefined()
  })

  it('clearPendingProposal clears the slot', () => {
    useChatStore.getState().setPendingProposal(makeProposal())
    expect(useChatStore.getState().pendingProposal).toBeDefined()
    useChatStore.getState().clearPendingProposal()
    expect(useChatStore.getState().pendingProposal).toBeUndefined()
  })

  it('publish -> acceptPendingProposal swaps editedScore and clears the slot', () => {
    seedScore()
    const epochBefore = useChatStore.getState().epoch
    useChatStore.getState().setPendingProposal(makeProposal(['e1']))

    // Pre-accept invariant: editedScore still points at beforeScore.
    expect(useChatStore.getState().editedScore).toBe(BEFORE_SCORE)

    useChatStore.getState().acceptPendingProposal()

    const s = useChatStore.getState()
    expect(s.pendingProposal).toBeUndefined()
    expect(s.editedScore).toBe(AFTER_SCORE)
    expect(s.scoreJson).toBe(AFTER_SCORE)
    expect(s.abc).toBe('X:1\nK:C\nC E E F|')
    expect(s.introText).toBe('Raised the second note to E.')
    // History reset to a single entry on the new score — matches
    // resolveRequest semantics (every LLM-sourced score is a checkpoint).
    expect(s.history).toEqual([AFTER_SCORE])
    expect(s.historyPointer).toBe(0)
    expect(s.lastCoalesceKey).toBeUndefined()
    expect(s.lastCoalesceAt).toBe(0)
    expect(s.editMap).toBeDefined()
    // Epoch bumps so ScoreStage runs the crossfade animation.
    expect(s.epoch).toBe(epochBefore + 1)
  })

  it('publish -> rejectPendingProposal clears the slot without touching score state', () => {
    seedScore()
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 2 } })
    const epochBefore = useChatStore.getState().epoch

    useChatStore.getState().setPendingProposal(makeProposal(['e1']))
    useChatStore.getState().rejectPendingProposal()

    const s = useChatStore.getState()
    expect(s.pendingProposal).toBeUndefined()
    // editedScore + scoreJson untouched.
    expect(s.editedScore).toBe(BEFORE_SCORE)
    expect(s.scoreJson).toBe(BEFORE_SCORE)
    // selection untouched (reject is purely a slot operation).
    expect(s.selection).toEqual({ measureIdx: 0, eventIdx: 2 })
    // No crossfade — reject must not feel like a state change.
    expect(s.epoch).toBe(epochBefore)
  })

  it('acceptPendingProposal is a no-op when no proposal is pending', () => {
    seedScore()
    const before = useChatStore.getState()
    useChatStore.getState().acceptPendingProposal()
    const after = useChatStore.getState()
    expect(after.editedScore).toBe(before.editedScore)
    expect(after.epoch).toBe(before.epoch)
    expect(after.history).toEqual(before.history)
  })

  it('rejectPendingProposal is a no-op when no proposal is pending', () => {
    seedScore()
    const before = useChatStore.getState()
    useChatStore.getState().rejectPendingProposal()
    const after = useChatStore.getState()
    expect(after.editedScore).toBe(before.editedScore)
    expect(after.epoch).toBe(before.epoch)
    expect(after.pendingProposal).toBeUndefined()
  })

  it('setPendingProposal replaces a prior slot (re-publish)', () => {
    useChatStore
      .getState()
      .setPendingProposal(makeProposal(['e1'], { candidateVersionId: 'cand-A' }))
    useChatStore
      .getState()
      .setPendingProposal(
        makeProposal(['e0', 'e1', 'e2', 'e3', 'e4'], { candidateVersionId: 'cand-B' }),
      )
    const slot = useChatStore.getState().pendingProposal
    expect(slot!.candidateVersionId).toBe('cand-B')
    expect(slot!.presentation).toBe('diff-panel')
  })

  it('pendingConfirmation and pendingProposal are independent slots', () => {
    // Sanity check — the two preview/proposal mechanisms (M3.5-PR-4 and
    // M24) coexist. Setting one must not clobber the other; the UI
    // gates so only one is ever visible at a time (PR-3 work), but the
    // store doesn't enforce mutual exclusion.
    useChatStore.getState().setPendingProposal(makeProposal())
    useChatStore.setState({
      pendingConfirmation: {
        chatId: 'c',
        candidateVersionId: 'cv',
        candidateScore: AFTER_SCORE,
        beforeScore: BEFORE_SCORE,
        retainedIdentityRatio: 0,
        reasons: ['x'],
        toolUseId: 't',
        introText: 'i',
        abc: 'X:1',
      },
    })
    expect(useChatStore.getState().pendingProposal).toBeDefined()
    expect(useChatStore.getState().pendingConfirmation).toBeDefined()

    useChatStore.getState().clearPendingProposal()
    expect(useChatStore.getState().pendingProposal).toBeUndefined()
    expect(useChatStore.getState().pendingConfirmation).toBeDefined()
  })
})
