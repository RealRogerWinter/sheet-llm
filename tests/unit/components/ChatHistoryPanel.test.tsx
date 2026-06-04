import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ChatHistoryPanel from '@/components/ChatHistoryPanel'
import { useChatStore } from '@/lib/chat/state'
import type { TranscriptTurn } from '@/lib/shared/types'

// jsdom doesn't implement matchMedia; the helper below stubs it. The
// default ("no match") routes the panel to 'drawer' mode (the middle
// case — neither docked nor sheet). `mockMatchMedia` lets a test force
// the docked breakpoint (>=1280px) to exercise the permanent-sidebar path.
function mockMatchMedia(matcher: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matcher(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

// A non-empty abc means "a score is loaded" — the panel only renders in
// the editor, never on the hero. Most tests need one set.
const ABC = 'X:1\nK:C\nC4|'

beforeEach(() => {
  mockMatchMedia(() => false)

  // Reset state before each test. `abc` is set so the panel is past the
  // hero gate; individual tests that exercise the hero clear it.
  useChatStore.setState({
    chatId: undefined,
    abc: ABC,
    turns: [],
    transcriptLoading: false,
    transcriptError: undefined,
    transcriptRetryNonce: 0,
    panelOpen: false,
    cheatSheetOpen: false,
    error: undefined,
  })

  cleanup()
})

const USER_TURN_1: TranscriptTurn = { role: 'user', kind: 'text', text: 'a C scale' }
const ASSISTANT_TURN_1: TranscriptTurn = {
  role: 'assistant',
  kind: 'render_score',
  introText: 'Here you go.',
  scoreSummary: { title: 'First', key: 'C', meter: '4/4', measureCount: 1 },
  toolUseId: 'toolu_1',
  scoreHash: 'h1',
}
const USER_TURN_2: TranscriptTurn = {
  role: 'user',
  kind: 'refinement',
  text: 'now in G',
  hadEdit: true,
  toolUseId: 'toolu_1',
}
const ASSISTANT_TURN_2: TranscriptTurn = {
  role: 'assistant',
  kind: 'render_score',
  scoreSummary: { title: 'Second', key: 'G', meter: '3/4', measureCount: 4, tempo_bpm: 120 },
  toolUseId: 'toolu_2',
  scoreHash: 'h2',
}

describe('<ChatHistoryPanel />', () => {
  it('renders nothing when panelOpen is false (narrow/drawer mode)', () => {
    const { container } = render(<ChatHistoryPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when no score is loaded (hero state)', () => {
    // No abc → the hero / landing state. The panel must never show here,
    // regardless of panelOpen.
    useChatStore.setState({ abc: undefined, panelOpen: true, chatId: 'chat-1' })
    const { container } = render(<ChatHistoryPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('always renders in docked mode (>=1280px) without a close button', () => {
    // Docked = permanent sidebar: ignores panelOpen, no dismiss affordance.
    mockMatchMedia((q) => q.includes('min-width: 1280px'))
    useChatStore.setState({ panelOpen: false, chatId: 'chat-1', turns: [USER_TURN_1] })
    render(<ChatHistoryPanel />)
    // Panel is present (complementary landmark, not a dialog).
    expect(screen.getByRole('complementary', { name: /chat history/i })).toBeInTheDocument()
    // No close button in the permanent sidebar.
    expect(
      screen.queryByRole('button', { name: /close conversation panel/i }),
    ).toBeNull()
  })

  it('does not render the docked panel on the hero even at >=1280px', () => {
    mockMatchMedia((q) => q.includes('min-width: 1280px'))
    useChatStore.setState({ abc: undefined, panelOpen: true, chatId: 'chat-1' })
    const { container } = render(<ChatHistoryPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the empty state when open with no chatId', () => {
    useChatStore.setState({ panelOpen: true })
    render(<ChatHistoryPanel />)
    expect(screen.getByText(/your conversation will appear here/i)).toBeInTheDocument()
  })

  it('renders user and assistant turns in order', () => {
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      turns: [USER_TURN_1, ASSISTANT_TURN_1, USER_TURN_2, ASSISTANT_TURN_2],
    })
    render(<ChatHistoryPanel />)

    expect(screen.getByText('a C scale')).toBeInTheDocument()
    expect(screen.getByText('Here you go.')).toBeInTheDocument()
    expect(screen.getByText('now in G')).toBeInTheDocument()
    expect(screen.getByText('Edited score before sending')).toBeInTheDocument()
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('marks only the last assistant turn as Current', () => {
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      turns: [USER_TURN_1, ASSISTANT_TURN_1, USER_TURN_2, ASSISTANT_TURN_2],
    })
    render(<ChatHistoryPanel />)
    const currentBadges = screen.getAllByText('Current')
    expect(currentBadges).toHaveLength(1)
  })

  it('shows Revert link on older assistant turns only', () => {
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      turns: [USER_TURN_1, ASSISTANT_TURN_1, USER_TURN_2, ASSISTANT_TURN_2],
    })
    render(<ChatHistoryPanel />)
    const reverts = screen.getAllByRole('button', { name: /revert to this version/i })
    expect(reverts).toHaveLength(1)
  })

  it('renders an error chip pinned after the trailing user turn', () => {
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      turns: [USER_TURN_1],
      error: 'Network borked',
    })
    render(<ChatHistoryPanel />)
    expect(screen.getByRole('alert')).toHaveTextContent('Network borked')
  })

  it('renders an errored assistant turn as a failure bubble with its message', () => {
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      turns: [
        USER_TURN_1,
        {
          role: 'assistant',
          kind: 'text',
          text: 'Here is the start',
          toolUseId: 'toolu_err',
          errored: true,
          errorText: 'The model failed halfway through.',
        },
      ],
    })
    render(<ChatHistoryPanel />)
    // Any partial text that streamed in before the failure is preserved.
    expect(screen.getByText('Here is the start')).toBeInTheDocument()
    // The failure label + the human message both surface in the chat.
    expect(screen.getByText('Generation failed')).toBeInTheDocument()
    expect(screen.getByText('The model failed halfway through.')).toBeInTheDocument()
  })

  it('maps an errorCode to a friendly message when no errorText is present', () => {
    // Server-hydrated errored turns carry only an errorCode.
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      turns: [
        USER_TURN_1,
        {
          role: 'assistant',
          kind: 'text',
          text: '',
          toolUseId: 'toolu_err2',
          errored: true,
          errorCode: 'stale_partial',
        },
      ],
    })
    render(<ChatHistoryPanel />)
    expect(
      screen.getByText('This response was interrupted and never finished.'),
    ).toBeInTheDocument()
  })

  it('renders transcript error with retry button', () => {
    useChatStore.setState({
      panelOpen: true,
      chatId: 'chat-1',
      transcriptError: 'Could not load',
    })
    render(<ChatHistoryPanel />)
    expect(screen.getByText('Could not load')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('clicking close button closes the panel', () => {
    useChatStore.setState({ panelOpen: true, chatId: 'chat-1', turns: [USER_TURN_1] })
    render(<ChatHistoryPanel />)
    fireEvent.click(screen.getByRole('button', { name: /close conversation panel/i }))
    expect(useChatStore.getState().panelOpen).toBe(false)
  })

  it('clicking the backdrop (drawer mode) closes the panel', () => {
    useChatStore.setState({ panelOpen: true, chatId: 'chat-1', turns: [USER_TURN_1] })
    const { container } = render(<ChatHistoryPanel />)
    const backdrop = container.querySelector('[role="presentation"]')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)
    expect(useChatStore.getState().panelOpen).toBe(false)
  })
})
