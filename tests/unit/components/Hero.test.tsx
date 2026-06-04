import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

// Heavy descendants that render the actual score / audio host / modal
// shell aren't relevant to the displayed-abc swap and would require an
// abcjs render in jsdom. Replace with light stubs that surface the
// props we want to assert against.
vi.mock('@/components/ScoreStage', () => ({
  default: (props: { abc: string | undefined }) => (
    <div data-testid="score-stage" data-abc={props.abc ?? ''} />
  ),
}))
vi.mock('@/components/ExportBar', () => ({ default: () => <div /> }))
vi.mock('@/components/ScoreZoomBar', () => ({ default: () => <div /> }))
vi.mock('@/components/PromptBar', () => ({ default: () => <div /> }))
vi.mock('@/components/LastPromptLabel', () => ({ default: () => <div /> }))
vi.mock('@/components/LastConfirmationLabel', () => ({ default: () => <div /> }))
vi.mock('@/components/ErrorToast', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/EditorToolbar', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/NoteFloatingMenu', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/EditedPill', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/Coachmark', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/CheatSheet', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/CommandPalette', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/useCommandPalette', () => ({ useCommandPalette: () => undefined }))
vi.mock('@/components/editor/UndoToast', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/StatusStrip', () => ({ default: () => <div /> }))
vi.mock('@/components/editor/BlankScoreHint', () => ({ default: () => <div /> }))
vi.mock('@/components/orchestrator/ReplacementConfirmModal', () => ({
  ReplacementConfirmModal: () => <div />,
}))

const Hero = (await import('@/components/Hero')).default

const BASE_SCORE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] }],
}

const CANDIDATE_SCORE: Score = {
  title: 'candidate',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' }] }],
}

function freshStore() {
  useChatStore.setState({
    chatId: 'chat-1',
    abc: 'X:1\nK:C\nC4|',
    scoreJson: BASE_SCORE,
    editedScore: BASE_SCORE,
    pending: false,
    pendingProposal: undefined,
    pendingConfirmation: undefined,
  })
}

describe('<Hero /> — displayed abc swap on pendingProposal (M24-PR-3b)', () => {
  beforeEach(() => {
    cleanup()
    freshStore()
  })

  it('renders the store abc when no proposal is pending', () => {
    const { getByTestId } = render(<Hero />)
    expect(getByTestId('score-stage').getAttribute('data-abc')).toBe('X:1\nK:C\nC4|')
  })

  it('swaps to candidate abc when an inline proposal is pending', () => {
    useChatStore.getState().setPendingProposal({
      chatId: 'chat-1',
      candidateVersionId: 'cand-1',
      candidateScore: CANDIDATE_SCORE,
      beforeScore: BASE_SCORE,
      abc: 'X:1\nK:C\nE4|',
      affectedEventIds: ['e0'],
      introText: 'Raised to E',
      toolUseId: 'tool-1',
    })
    const { getByTestId } = render(<Hero />)
    expect(getByTestId('score-stage').getAttribute('data-abc')).toBe('X:1\nK:C\nE4|')
  })

  it('swaps to candidate abc even when proposal is diff-panel presentation', () => {
    // Both inline AND diff-panel proposals show the candidate score
    // beneath the overlay/panel. The presentation differs in the
    // OVERLAY treatment, not the score render.
    useChatStore.getState().setPendingProposal({
      chatId: 'chat-1',
      candidateVersionId: 'cand-2',
      candidateScore: CANDIDATE_SCORE,
      beforeScore: BASE_SCORE,
      abc: 'X:1\nK:C\nE4 F4 G4 A4 B4|',
      affectedEventIds: ['e0', 'e1', 'e2', 'e3', 'e4'],
      introText: 'Big change',
      toolUseId: 'tool-2',
    })
    // Sanity: this is the diff-panel branch.
    expect(useChatStore.getState().pendingProposal!.presentation).toBe('diff-panel')
    const { getByTestId } = render(<Hero />)
    expect(getByTestId('score-stage').getAttribute('data-abc')).toBe(
      'X:1\nK:C\nE4 F4 G4 A4 B4|',
    )
  })

  it('falls back to store abc when proposal is cleared', () => {
    useChatStore.getState().setPendingProposal({
      chatId: 'chat-1',
      candidateVersionId: 'cand-1',
      candidateScore: CANDIDATE_SCORE,
      beforeScore: BASE_SCORE,
      abc: 'X:1\nK:C\nE4|',
      affectedEventIds: ['e0'],
      introText: 'Raised',
      toolUseId: 'tool-1',
    })
    const { getByTestId, rerender } = render(<Hero />)
    expect(getByTestId('score-stage').getAttribute('data-abc')).toBe('X:1\nK:C\nE4|')

    useChatStore.getState().clearPendingProposal()
    rerender(<Hero />)
    expect(getByTestId('score-stage').getAttribute('data-abc')).toBe('X:1\nK:C\nC4|')
  })
})
