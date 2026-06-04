import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { GhostPreviewPanel } from '@/components/orchestrator/GhostPreviewPanel'
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
    {
      events: [
        { id: 'b0', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { id: 'b1', pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

// AFTER: 5 events changed (forces diff-panel presentation).
const CANDIDATE_SCORE: Score = {
  title: 'baseline',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'a0', pitches: [{ step: 'C', octave: 4 }], duration: 'half' }, // duration change
        { id: 'a1', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' }, // pitch change
        { id: 'a2', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' }, // pitch change
        { id: 'a3', pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' }, // pitch change
        { id: 'a4', pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' }, // inserted
      ],
    },
    {
      events: [
        { id: 'b0', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { id: 'b1', pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const CHAT_ID = '00000000-0000-0000-0000-0000000000aa'
const CANDIDATE_ID = '00000000-0000-0000-0000-0000000000dd'

function seedDiffPanelProposal(
  affectedEventIds: string[] = ['a0', 'a1', 'a2', 'a3', 'a4'],
) {
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
    abc: 'X:1\nK:C\n...',
    affectedEventIds,
    introText: 'Rewrote bar 1 as an arpeggio.',
    toolUseId: 'toolu_panel_1',
    headVersionId: 'head-1',
  })
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
    panelOpen: false,
    turns: [],
    currentHeadVersionId: undefined,
  })
})

afterEach(() => {
  useChatStore.setState({ pendingProposal: undefined })
})

describe('<GhostPreviewPanel />', () => {
  it('renders nothing when no proposal is pending', () => {
    const { container } = render(<GhostPreviewPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when proposal is inline presentation (PR-3c handles those)', () => {
    seedDiffPanelProposal(['a1']) // 1 event → inline
    expect(useChatStore.getState().pendingProposal!.presentation).toBe('inline')
    const { container } = render(<GhostPreviewPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the panel with header + intro + per-event diff rows + buttons', () => {
    seedDiffPanelProposal()
    expect(useChatStore.getState().pendingProposal!.presentation).toBe('diff-panel')
    render(<GhostPreviewPanel />)
    expect(screen.getByRole('dialog', { name: /AI proposal — 5 changes/i })).toBeInTheDocument()
    expect(screen.getByText('AI proposal')).toBeInTheDocument()
    expect(screen.getByText('5 changes')).toBeInTheDocument()
    expect(screen.getByText('Rewrote bar 1 as an arpeggio.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Accept all/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reject AI proposal/i })).toBeInTheDocument()
  })

  it('renders one diff row per affected event with bar/beat + before/after labels', () => {
    seedDiffPanelProposal()
    render(<GhostPreviewPanel />)
    // a0: pitch unchanged (C4) but duration quarter→half.
    expect(screen.getByText(/bar 1, beat 1/i)).toBeInTheDocument()
    // a4 is the inserted event — beforeLabel should read "(new)".
    expect(screen.getByText('(new)')).toBeInTheDocument()
    // a1: D4→E4. The "E4 (quarter)" string appears as a1's AFTER
    // label AND as a2's BEFORE label, so use getAllByText.
    expect(screen.getByText('D4 (quarter)')).toBeInTheDocument()
    expect(screen.getAllByText('E4 (quarter)').length).toBeGreaterThanOrEqual(1)
    // a0's duration change: half on the after side.
    expect(screen.getByText('C4 (half)')).toBeInTheDocument()
  })

  it('"1 change" singular form when exactly one event affected (and presentation forced to diff-panel)', () => {
    seedDiffPanelProposal(['a1'])
    // Force diff-panel even though length=1 normally yields inline.
    const slot = useChatStore.getState().pendingProposal!
    useChatStore.setState({
      pendingProposal: { ...slot, presentation: 'diff-panel' },
    })
    render(<GhostPreviewPanel />)
    expect(screen.getByText('1 change')).toBeInTheDocument()
  })

  it('closes the chat history panel when active', () => {
    useChatStore.setState({ panelOpen: true })
    seedDiffPanelProposal()
    render(<GhostPreviewPanel />)
    expect(useChatStore.getState().panelOpen).toBe(false)
  })

  it('Accept POSTs decision=accept, swaps the score, updates head, appends turn', async () => {
    seedDiffPanelProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    render(<GhostPreviewPanel />)

    fireEvent.click(screen.getByRole('button', { name: /Accept all/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({ body: expect.stringContaining('"decision":"accept"') }),
      )
    })

    await waitFor(() => {
      const s = useChatStore.getState()
      expect(s.pendingProposal).toBeUndefined()
      expect(s.editedScore).toEqual(CANDIDATE_SCORE)
      expect(s.currentHeadVersionId).toBe('head-promoted')
      expect(s.turns.filter((t) => t.role === 'assistant')).toHaveLength(1)
    })
  })

  it('Reject POSTs decision=reject, clears the slot, score unchanged', async () => {
    seedDiffPanelProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-reverted' })
    render(<GhostPreviewPanel />)

    fireEvent.click(screen.getByRole('button', { name: /Reject AI proposal/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({ body: expect.stringContaining('"decision":"reject"') }),
      )
    })

    await waitFor(() => {
      const s = useChatStore.getState()
      expect(s.pendingProposal).toBeUndefined()
      expect(s.editedScore).toEqual(BEFORE_SCORE)
      expect(s.currentHeadVersionId).toBe('head-reverted')
    })
  })

  it('Enter key accepts (with textarea-focus guard)', async () => {
    seedDiffPanelProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    render(<GhostPreviewPanel />)

    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({ body: expect.stringContaining('"decision":"accept"') }),
      )
    })
  })

  it('Escape key rejects', async () => {
    seedDiffPanelProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-reverted' })
    render(<GhostPreviewPanel />)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/confirm-replacement',
        expect.objectContaining({ body: expect.stringContaining('"decision":"reject"') }),
      )
    })
  })

  it('Enter while a textarea has focus does NOT accept', async () => {
    seedDiffPanelProposal()
    const fetchMock = mockFetchOk({ headVersionId: 'head-promoted' })
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    render(<GhostPreviewPanel />)

    fireEvent.keyDown(window, { key: 'Enter' })
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().pendingProposal).toBeDefined()
    document.body.removeChild(ta)
  })

  it('shows an error message + leaves the slot intact when the POST fails', async () => {
    seedDiffPanelProposal()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'server unavailable' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    render(<GhostPreviewPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Accept all/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/server unavailable/i)
    })
    expect(useChatStore.getState().pendingProposal).toBeDefined()
  })
})
