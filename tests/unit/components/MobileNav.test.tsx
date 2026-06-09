import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import MobileNav from '@/components/MobileNav'
import { useChatStore } from '@/lib/chat/state'
import { useAuthStore } from '@/lib/auth/authStore'

// Control the legal gate directly (the real hook is module-memoized, which
// would leak across tests).
let legalEnabled = false
vi.mock('@/lib/legal/useLegalEnabled', () => ({
  useLegalEnabled: () => legalEnabled,
}))

// Stub the heavy modals so opening them doesn't pull their dependency trees.
vi.mock('@/components/import/ImportModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="import-modal">
      <button onClick={onClose}>close-import</button>
    </div>
  ),
}))
vi.mock('@/components/HelpModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="help-modal">
      <button onClick={onClose}>close-help</button>
    </div>
  ),
}))

const createBlankScore = vi.fn(async () => ({ ok: true as const }))
vi.mock('@/components/import/createBlankScore', () => ({
  createBlankScore: () => createBlankScore(),
}))

const logout = vi.fn(async () => {})
vi.mock('@/lib/auth/authClient', () => ({
  logout: () => logout(),
}))

const reset = vi.fn(async () => {})
const openLogin = vi.fn()
const openSignup = vi.fn()

const ABC = 'X:1\nK:C\nC4|'

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  return screen.getByRole('menu', { name: 'Navigation' })
}

beforeEach(() => {
  cleanup()
  legalEnabled = false
  vi.clearAllMocks()
  document.documentElement.removeAttribute('data-theme')
  // Default: anonymous, no content, idle.
  useChatStore.setState({ abc: undefined, chatId: undefined, pending: false, reset })
  useAuthStore.setState({ status: 'anon', email: null, openLogin, openSignup })
})

afterEach(() => cleanup())

describe('<MobileNav />', () => {
  it('trigger declares the popup and reflects open state', () => {
    render(<MobileNav />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Navigation' })).toBeInTheDocument()
  })

  it('consolidates the secondary controls as menu items', () => {
    render(<MobileNav />)
    const menu = openMenu()
    for (const label of [
      'New from prompt',
      'New blank score',
      'Import a score',
      'Help & quick start',
      'Pricing & credits',
      'GitHub',
    ]) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument()
    }
  })

  it('disables "New from prompt" when there is no content, enables it when there is', () => {
    render(<MobileNav />)
    expect(within(openMenu()).getByRole('menuitem', { name: 'New from prompt' })).toBeDisabled()
    cleanup()
    useChatStore.setState({ abc: ABC })
    render(<MobileNav />)
    expect(within(openMenu()).getByRole('menuitem', { name: 'New from prompt' })).toBeEnabled()
  })

  it('disables New + Import while a generation is pending', () => {
    useChatStore.setState({ abc: ABC, pending: true })
    render(<MobileNav />)
    const menu = openMenu()
    expect(within(menu).getByRole('menuitem', { name: 'New from prompt' })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: 'New blank score' })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: 'Import a score' })).toBeDisabled()
  })

  it('mirrors the NewMenu confirm gate: blank score with content asks first', () => {
    useChatStore.setState({ abc: ABC })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MobileNav />)
    // Cancel: confirm runs, action does not, and the menu stays open (we confirm
    // BEFORE closing, so a cancel doesn't silently dismiss the menu).
    const menu = openMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New blank score' }))
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(createBlankScore).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Navigation' })).toBeInTheDocument()
    // Accept: from the still-open menu, the action runs.
    confirmSpy.mockReturnValue(true)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New blank score' }))
    expect(createBlankScore).toHaveBeenCalledOnce()
  })

  it('shows Log in / Sign up for anonymous users and wires the store actions', () => {
    render(<MobileNav />)
    const menu = openMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Log in' }))
    expect(openLogin).toHaveBeenCalledOnce()
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Sign up' }))
    expect(openSignup).toHaveBeenCalledOnce()
  })

  it('shows the account + log out for authed users', () => {
    useAuthStore.setState({ status: 'authed', email: 'a@b.com' })
    render(<MobileNav />)
    const menu = openMenu()
    expect(within(menu).getByRole('menuitem', { name: 'a@b.com' })).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Log out' }))
    expect(logout).toHaveBeenCalledOnce()
  })

  it('renders no auth section while auth is loading or disabled', () => {
    useAuthStore.setState({ status: 'loading' })
    render(<MobileNav />)
    expect(within(openMenu()).queryByRole('menuitem', { name: 'Log in' })).toBeNull()
    cleanup()
    useAuthStore.setState({ status: 'disabled' })
    render(<MobileNav />)
    expect(within(openMenu()).queryByRole('menuitem', { name: 'Log in' })).toBeNull()
  })

  it('gates the legal links on /api/legal', () => {
    render(<MobileNav />)
    expect(within(openMenu()).queryByRole('menuitem', { name: 'Terms of Service' })).toBeNull()
    cleanup()
    legalEnabled = true
    render(<MobileNav />)
    const menu = openMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Terms of Service' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Privacy Policy' })).toBeInTheDocument()
  })

  it('toggles the theme and closes the menu', () => {
    render(<MobileNav />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Switch to dark theme' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the Import modal after closing the menu', () => {
    render(<MobileNav />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Import a score' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByTestId('import-modal')).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    render(<MobileNav />)
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // ── Focus management (WCAG 2.4.3) ──────────────────────────────────────────

  it('exposes labelled ARIA groups for each section', () => {
    useAuthStore.setState({ status: 'authed', email: 'a@b.com' })
    render(<MobileNav />)
    const menu = openMenu()
    for (const name of ['Compose', 'App', 'Account', 'More']) {
      expect(within(menu).getByRole('group', { name })).toBeInTheDocument()
    }
  })

  it('moves focus to the first enabled item on open (skips a disabled item)', () => {
    render(<MobileNav />) // no content → "New from prompt" is disabled
    const menu = openMenu()
    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: 'New blank score' }),
    )
  })

  it('restores focus to the trigger on Escape', () => {
    render(<MobileNav />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('restores focus to the trigger on outside press', () => {
    render(<MobileNav />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    openMenu()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('restores focus to the trigger after a same-page item action (theme)', () => {
    render(<MobileNav />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Switch to dark theme' }))
    expect(document.activeElement).toBe(trigger)
  })

  it('does NOT force focus back to the trigger when opening a modal surface (Log in)', () => {
    render(<MobileNav />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Log in' }))
    expect(openLogin).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).not.toBe(trigger) // focus follows the auth modal
  })

  // ── Confirm gate (From prompt) ─────────────────────────────────────────────

  it('cancelling the From-prompt confirm leaves the menu open and does not reset', () => {
    useChatStore.setState({ abc: ABC, reset })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MobileNav />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'New from prompt' }))
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(reset).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Navigation' })).toBeInTheDocument() // still open
  })

  it('confirming From-prompt closes the menu and resets', () => {
    useChatStore.setState({ abc: ABC, reset })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MobileNav />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'New from prompt' }))
    expect(reset).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // ── Roving focus (role=menu contract) ──────────────────────────────────────

  it('arrow keys rove focus between enabled items and wrap', () => {
    useChatStore.setState({ abc: ABC }) // all New items enabled
    render(<MobileNav />)
    const menu = openMenu()
    const first = within(menu).getByRole('menuitem', { name: 'New from prompt' })
    const second = within(menu).getByRole('menuitem', { name: 'New blank score' })
    const github = within(menu).getByRole('menuitem', { name: 'GitHub' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(menu, { key: 'ArrowUp' }) // wrap to last
    expect(document.activeElement).toBe(github)
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(github)
  })
})
