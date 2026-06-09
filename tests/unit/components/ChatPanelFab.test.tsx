import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ChatPanelFab from '@/components/ChatPanelFab'
import { useChatStore } from '@/lib/chat/state'
import type { TranscriptTurn } from '@/lib/shared/types'

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

const ABC = 'X:1\nK:C\nC4|'
const TURN: TranscriptTurn = { role: 'user', kind: 'text', text: 'a C scale' }

beforeEach(() => {
  cleanup()
  // Default: below the dock breakpoint (matchMedia false → not docked).
  mockMatchMedia(() => false)
  useChatStore.setState({
    abc: ABC,
    turns: [TURN],
    panelOpen: false,
    cheatSheetOpen: false,
  })
})

describe('<ChatPanelFab />', () => {
  it('opens the panel (sets panelOpen) when clicked', () => {
    render(<ChatPanelFab />)
    expect(useChatStore.getState().panelOpen).toBe(false)
    fireEvent.click(screen.getByRole('button'))
    expect(useChatStore.getState().panelOpen).toBe(true)
  })

  it('hides itself once the panel is open (the panel owns its own dismiss controls)', () => {
    const { container, rerender } = render(<ChatPanelFab />)
    fireEvent.click(screen.getByRole('button'))
    rerender(<ChatPanelFab />)
    expect(container.firstChild).toBeNull()
  })

  it('wires aria-controls + aria-expanded for the panel', () => {
    render(<ChatPanelFab />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-controls', 'chat-history-panel')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders nothing when there is no conversation to show (no abc)', () => {
    useChatStore.setState({ abc: undefined, turns: [] })
    const { container } = render(<ChatPanelFab />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when there are no turns yet (mirror the panel render gate)', () => {
    useChatStore.setState({ abc: ABC, turns: [] })
    const { container } = render(<ChatPanelFab />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing in docked mode (>=1280px) — the panel is permanent there', () => {
    mockMatchMedia((q) => q.includes('min-width: 1280px'))
    const { container } = render(<ChatPanelFab />)
    expect(container.firstChild).toBeNull()
  })
})
