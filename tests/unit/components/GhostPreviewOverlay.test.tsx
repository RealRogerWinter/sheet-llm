import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { GhostPreviewOverlay } from '@/components/orchestrator/GhostPreviewOverlay'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const BEFORE_SCORE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'a0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: 'a1', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { id: 'a2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'a3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const CANDIDATE_SCORE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'a0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { id: 'a1', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'a2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { id: 'a3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const CHAT_ID = '00000000-0000-0000-0000-0000000000aa'
const CANDIDATE_ID = '00000000-0000-0000-0000-0000000000cc'

function seedProposal(overrides: Partial<{
  affectedEventIds: string[]
  presentation: 'inline' | 'diff-panel'
}> = {}) {
  // Use the store action so presentation is auto-computed correctly.
  useChatStore.setState({
    chatId: CHAT_ID,
    scoreJson: BEFORE_SCORE,
    editedScore: BEFORE_SCORE,
    pendingProposal: undefined,
  })
  useChatStore.getState().setPendingProposal({
    chatId: CHAT_ID,
    candidateVersionId: CANDIDATE_ID,
    candidateScore: CANDIDATE_SCORE,
    beforeScore: BEFORE_SCORE,
    abc: 'X:1\nK:C\nC E E F|',
    affectedEventIds: overrides.affectedEventIds ?? ['a1'],
    introText: 'Raised the second note.',
    toolUseId: 'toolu_gp_1',
    headVersionId: 'head-1',
  })
  // For tests that want to force the diff-panel branch, override the
  // computed presentation directly.
  if (overrides.presentation) {
    const slot = useChatStore.getState().pendingProposal!
    useChatStore.setState({
      pendingProposal: { ...slot, presentation: overrides.presentation },
    })
  }
}

function mockFetchOk(json: unknown = { headVersionId: 'head-promoted' }) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

beforeEach(() => {
  cleanup()
  useChatStore.setState({
    pendingProposal: undefined,
    pendingConfirmation: undefined,
    turns: [],
    currentHeadVersionId: undefined,
  })
})

afterEach(() => {
  useChatStore.setState({ pendingProposal: undefined })
})

describe('<GhostPreviewOverlay />', () => {
  it('renders nothing when no proposal is pending', () => {
    const { container } = render(<GhostPreviewOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when proposal is diff-panel presentation (PR-4 handles those)', () => {
    seedProposal({
      affectedEventIds: ['a0', 'a1', 'a2', 'a3', 'a4'],
      presentation: 'diff-panel',
    })
    const { container } = render(<GhostPreviewOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('renders accept/reject toolbar + intro text when inline proposal active', () => {
    seedProposal()
    render(<GhostPreviewOverlay />)
    expect(screen.getByRole('dialog', { name: /AI proposal/i })).toBeInTheDocument()
    expect(screen.getByText('Raised the second note.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Accept AI proposal/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reject AI proposal/i })).toBeInTheDocument()
  })

  it('does NOT inject the amber <style> itself — that moved to GhostPreviewAmber', () => {
    // The on-score recolor is now owned by the shared, presentation-
    // agnostic GhostPreviewAmber component (mounted in Hero) so it
    // applies to diff-panel proposals too. The inline toolbar must not
    // double-inject it.
    seedProposal({ affectedEventIds: ['a1'] })
    const { container } = render(<GhostPreviewOverlay />)
    expect(container.querySelector('style')).toBeNull()
  })

  it('Accept button POSTs decision=accept, swaps the score, updates head, and appends a turn', async () => {
    seedProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    render(<GhostPreviewOverlay />)

    fireEvent.click(screen.getByRole('button', { name: /Accept AI proposal/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"decision":"accept"'),
        }),
      )
    })

    await waitFor(() => {
      const s = useChatStore.getState()
      expect(s.pendingProposal).toBeUndefined()
      expect(s.editedScore).toEqual(CANDIDATE_SCORE)
      expect(s.scoreJson).toEqual(CANDIDATE_SCORE)
      expect(s.currentHeadVersionId).toBe('head-promoted')
      const renderTurns = s.turns.filter((t) => t.role === 'assistant' && t.kind === 'render_score')
      expect(renderTurns).toHaveLength(1)
      expect(renderTurns[0]).toMatchObject({
        toolUseId: 'toolu_gp_1',
        introText: 'Raised the second note.',
      })
    })
  })

  it('Reject button POSTs decision=reject, clears the slot, score stays at before', async () => {
    seedProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-reverted' })
    render(<GhostPreviewOverlay />)

    fireEvent.click(screen.getByRole('button', { name: /Reject AI proposal/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({
          body: expect.stringContaining('"decision":"reject"'),
        }),
      )
    })

    await waitFor(() => {
      const s = useChatStore.getState()
      expect(s.pendingProposal).toBeUndefined()
      // Score unchanged on reject — still at BEFORE_SCORE.
      expect(s.editedScore).toEqual(BEFORE_SCORE)
      expect(s.scoreJson).toEqual(BEFORE_SCORE)
      expect(s.currentHeadVersionId).toBe('head-reverted')
      // No assistant turn appended on reject.
      expect(s.turns.filter((t) => t.role === 'assistant')).toHaveLength(0)
    })
  })

  it('Enter key accepts the proposal (capture-phase keyboard)', async () => {
    seedProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    render(<GhostPreviewOverlay />)

    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({
          body: expect.stringContaining('"decision":"accept"'),
        }),
      )
    })
  })

  it('Escape key rejects the proposal', async () => {
    seedProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-reverted' })
    render(<GhostPreviewOverlay />)

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({
          body: expect.stringContaining('"decision":"reject"'),
        }),
      )
    })
  })

  it('shows an error message + leaves the slot intact when the POST fails', async () => {
    seedProposal()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'server unavailable' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    render(<GhostPreviewOverlay />)
    fireEvent.click(screen.getByRole('button', { name: /Accept AI proposal/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/server unavailable/i)
    })
    // Slot stays put so the user can retry.
    expect(useChatStore.getState().pendingProposal).toBeDefined()
  })

  it('rapid double-click on Accept fires only one POST', async () => {
    seedProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    render(<GhostPreviewOverlay />)

    const acceptBtn = screen.getByRole('button', { name: /Accept AI proposal/i })
    // Two synchronous clicks before the network resolves.
    fireEvent.click(acceptBtn)
    fireEvent.click(acceptBtn)

    await waitFor(() => {
      expect(useChatStore.getState().pendingProposal).toBeUndefined()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('Enter while typing in a textarea does NOT accept (textarea-focus guard)', async () => {
    seedProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    // Mount a textarea + the overlay; focus the textarea before firing Enter.
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    render(<GhostPreviewOverlay />)

    fireEvent.keyDown(window, { key: 'Enter' })

    // Give the (potential) async fetch a tick to fire.
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().pendingProposal).toBeDefined()
    document.body.removeChild(ta)
  })

  it('does not append a transcript turn on accept when the proposal lacks toolUseId', async () => {
    seedProposal()
    // Strip toolUseId off the slot to simulate the edge case.
    const slot = useChatStore.getState().pendingProposal!
    useChatStore.setState({ pendingProposal: { ...slot, toolUseId: '' } })
    mockFetchOk({ headVersionId: 'head-promoted' })
    render(<GhostPreviewOverlay />)

    fireEvent.click(screen.getByRole('button', { name: /Accept AI proposal/i }))

    await waitFor(() => {
      expect(useChatStore.getState().editedScore).toEqual(CANDIDATE_SCORE)
    })
    expect(
      useChatStore.getState().turns.filter((t) => t.role === 'assistant'),
    ).toHaveLength(0)
  })
})
