import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ReplacementConfirmModal } from '@/components/orchestrator/ReplacementConfirmModal'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const BEFORE_SCORE: Score = {
  title: 'Original',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const CANDIDATE_SCORE: Score = {
  title: 'New thing',
  key: 'Am',
  meter: '5/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

const CHAT_ID = '00000000-0000-0000-0000-0000000000aa'
const CANDIDATE_ID = '00000000-0000-0000-0000-0000000000bb'

function seedPending() {
  useChatStore.setState({
    pendingConfirmation: {
      chatId: CHAT_ID,
      candidateVersionId: CANDIDATE_ID,
      candidateScore: CANDIDATE_SCORE,
      beforeScore: BEFORE_SCORE,
      retainedIdentityRatio: 0,
      reasons: ['only 0 of 1 measures retained', 'key C → Am', 'meter 4/4 → 5/4'],
      toolUseId: 'toolu_test_candidate',
      introText: 'How about this?',
      abc: 'X:1\nK:Am\nM:5/4\n',
    },
  })
}

beforeEach(() => {
  useChatStore.setState({ pendingConfirmation: undefined })
  vi.restoreAllMocks()
  cleanup()
})

afterEach(() => {
  useChatStore.setState({ pendingConfirmation: undefined })
})

describe('<ReplacementConfirmModal />', () => {
  it('renders nothing when there is no pendingConfirmation', () => {
    const { container } = render(<ReplacementConfirmModal />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the reasons + the three buttons + before/after preview when pending', () => {
    seedPending()
    render(<ReplacementConfirmModal />)
    expect(screen.getByText(/AI proposed a major change/)).toBeInTheDocument()
    expect(screen.getByText('only 0 of 1 measures retained')).toBeInTheDocument()
    expect(screen.getByText('key C → Am')).toBeInTheDocument()
    expect(screen.getByText('meter 4/4 → 5/4')).toBeInTheDocument()

    expect(screen.getByText('Your current score')).toBeInTheDocument()
    expect(screen.getByText('AI proposal')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: /Replace anyway \(apply/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Keep my version/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Replace anyway and don't ask again/ }),
    ).toBeInTheDocument()
  })

  it('Replace anyway → POST decision=accept + closes modal', async () => {
    seedPending()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chatId: CHAT_ID,
          headVersionId: CANDIDATE_ID,
          replacementGateSuppressed: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ReplacementConfirmModal />)
    fireEvent.click(screen.getByRole('button', { name: /Replace anyway \(apply/ }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/confirm-replacement')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.decision).toBe('accept')
    expect(body.candidateVersionId).toBe(CANDIDATE_ID)

    await waitFor(() => {
      expect(useChatStore.getState().pendingConfirmation).toBeUndefined()
    })
  })

  it('Keep my version → POST decision=reject + leaves editor at prior score', async () => {
    seedPending()
    const REVERT_ID = '00000000-0000-0000-0000-0000000000cc'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chatId: CHAT_ID,
          headVersionId: REVERT_ID,
          replacementGateSuppressed: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ReplacementConfirmModal />)
    fireEvent.click(screen.getByRole('button', { name: /Keep my version/ }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.decision).toBe('reject')
    await waitFor(() => {
      expect(useChatStore.getState().pendingConfirmation).toBeUndefined()
    })
    // Editor state unchanged → currentHeadVersionId moved to the revert row id.
    expect(useChatStore.getState().currentHeadVersionId).toBe(REVERT_ID)
  })

  it("Replace anyway + don't ask again → POST decision=dont_ask_again_this_session", async () => {
    seedPending()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chatId: CHAT_ID,
          headVersionId: CANDIDATE_ID,
          replacementGateSuppressed: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ReplacementConfirmModal />)
    fireEvent.click(
      screen.getByRole('button', { name: /Replace anyway and don't ask again/ }),
    )

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.decision).toBe('dont_ask_again_this_session')
    await waitFor(() => {
      expect(useChatStore.getState().pendingConfirmation).toBeUndefined()
    })
  })

  it('ESC clears local state without posting (M1 fix)', async () => {
    // Pre-fix, ESC posted decision=reject and burned a DB write per
    // inadvertent keypress. After the fix, ESC dismisses the modal
    // locally — no fetch, no audit row.
    seedPending()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<ReplacementConfirmModal />)
    expect(useChatStore.getState().pendingConfirmation).toBeDefined()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(useChatStore.getState().pendingConfirmation).toBeUndefined()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error and stays open on POST failure', async () => {
    seedPending()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'server boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ReplacementConfirmModal />)
    fireEvent.click(screen.getByRole('button', { name: /Replace anyway \(apply/ }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('server boom')
    })
    // Modal stayed open.
    expect(useChatStore.getState().pendingConfirmation).toBeDefined()
  })
})
