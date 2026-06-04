import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  ResumeProposalToast,
  RESUME_TOAST_TIMEOUT_MS,
} from '@/components/orchestrator/ResumeProposalToast'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const BEFORE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [{ id: 'e0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }],
    },
  ],
}

const CANDIDATE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [{ id: 'e0', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' }],
    },
  ],
}

function seedInterrupted(candidateVersionId = 'cand-1') {
  useChatStore.setState({
    pendingProposal: undefined,
    interruptedProposal: {
      chatId: 'chat-1',
      candidateVersionId,
      candidateScore: CANDIDATE,
      beforeScore: BEFORE,
      abc: 'X:1\nK:C\nD4|',
      affectedEventIds: ['e0'],
      presentation: 'inline',
      introText: 'Raised C to D.',
      toolUseId: 'tool-1',
      headVersionId: 'head-1',
    },
  })
}

beforeEach(() => {
  cleanup()
  useChatStore.setState({
    pendingProposal: undefined,
    interruptedProposal: undefined,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('<ResumeProposalToast />', () => {
  it('renders nothing when no proposal was interrupted', () => {
    const { container } = render(<ResumeProposalToast />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the toast with Resume + Dismiss buttons when a proposal is interrupted', () => {
    seedInterrupted()
    render(<ResumeProposalToast />)
    expect(screen.getByRole('status')).toHaveTextContent(/AI suggestion paused/i)
    expect(screen.getByRole('button', { name: /^Resume$/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Dismiss resume-AI suggestion/i }),
    ).toBeInTheDocument()
  })

  it('Resume button restores the proposal to the pending slot', () => {
    seedInterrupted()
    render(<ResumeProposalToast />)
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }))
    const s = useChatStore.getState()
    expect(s.interruptedProposal).toBeUndefined()
    expect(s.pendingProposal?.candidateVersionId).toBe('cand-1')
    expect(s.pendingProposal?.candidateScore).toEqual(CANDIDATE)
  })

  it('Dismiss button clears the interrupted slot without restoring', () => {
    seedInterrupted()
    render(<ResumeProposalToast />)
    fireEvent.click(screen.getByRole('button', { name: /Dismiss resume-AI suggestion/i }))
    const s = useChatStore.getState()
    expect(s.interruptedProposal).toBeUndefined()
    expect(s.pendingProposal).toBeUndefined()
  })

  it('auto-dismisses after RESUME_TOAST_TIMEOUT_MS without user action', () => {
    vi.useFakeTimers()
    seedInterrupted()
    render(<ResumeProposalToast />)
    expect(useChatStore.getState().interruptedProposal).toBeDefined()

    act(() => {
      vi.advanceTimersByTime(RESUME_TOAST_TIMEOUT_MS + 100)
    })

    expect(useChatStore.getState().interruptedProposal).toBeUndefined()
  })

  it('a new interruption restarts the timer (does not inherit the old one)', () => {
    vi.useFakeTimers()
    seedInterrupted('cand-A')
    const { rerender } = render(<ResumeProposalToast />)

    // Advance most of the way to dismissal.
    act(() => {
      vi.advanceTimersByTime(RESUME_TOAST_TIMEOUT_MS - 1_000)
    })
    // Land a NEW interrupted proposal (different candidateVersionId).
    act(() => {
      seedInterrupted('cand-B')
    })
    rerender(<ResumeProposalToast />)

    // The old timer would have fired in ~1_000ms. Advance 1500ms — if
    // the new identity restarts the timer, the slot should STILL be
    // alive (only 1_500ms in on a fresh 30s clock).
    act(() => {
      vi.advanceTimersByTime(1_500)
    })

    expect(useChatStore.getState().interruptedProposal?.candidateVersionId).toBe('cand-B')

    // Now advance to past the new timer's end.
    act(() => {
      vi.advanceTimersByTime(RESUME_TOAST_TIMEOUT_MS)
    })
    expect(useChatStore.getState().interruptedProposal).toBeUndefined()
  })

  it('unmounting cancels the timer (no stray dismissal)', () => {
    vi.useFakeTimers()
    seedInterrupted()
    const { unmount } = render(<ResumeProposalToast />)
    unmount()

    act(() => {
      vi.advanceTimersByTime(RESUME_TOAST_TIMEOUT_MS + 1_000)
    })

    // Slot stays put because the timer was cleared on unmount.
    expect(useChatStore.getState().interruptedProposal).toBeDefined()
  })
})
