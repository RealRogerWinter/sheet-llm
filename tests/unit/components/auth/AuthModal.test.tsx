import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useAuthStore } from '@/lib/auth/authStore'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/auth/authClient', () => ({ login: vi.fn(), signup: vi.fn(), adoptAnonWork: vi.fn() }))
vi.mock('@/lib/auth/clientBackup', () => ({ clearBackup: vi.fn() }))
// AuthModal reads useChatStore.getState().abc and calls refreshSessions() imperatively.
const chatMock = vi.hoisted(() => ({ abc: undefined as unknown, refreshSessions: vi.fn() }))
vi.mock('@/lib/chat/state', () => ({
  useChatStore: { getState: () => ({ abc: chatMock.abc, refreshSessions: chatMock.refreshSessions }) },
}))

import AuthModal from '@/components/auth/AuthModal'
import { login, signup, adoptAnonWork } from '@/lib/auth/authClient'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  chatMock.abc = undefined
  useAuthStore.setState({ loginOpen: false, mode: 'login', oauthProviders: [], csrfToken: 't' })
})

describe('AuthModal', () => {
  it('renders nothing when closed', () => {
    useAuthStore.setState({ loginOpen: false })
    const { container } = render(<AuthModal />)
    expect(container).toBeEmptyDOMElement()
  })

  it('submits the login form (rememberMe default true) and closes on success', async () => {
    ;(login as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    useAuthStore.setState({ loginOpen: true, oauthProviders: [], csrfToken: 't' })
    const user = userEvent.setup()
    render(<AuthModal />)
    await user.type(screen.getByLabelText('Email'), 'a@b.c')
    await user.type(screen.getByLabelText('Password'), 'longpassword1')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(login).toHaveBeenCalledWith('a@b.c', 'longpassword1', true)
    expect(useAuthStore.getState().loginOpen).toBe(false)
  })

  it('adopts anon work on a plain login (no score on screen) before refreshing the sidebar', async () => {
    // SHE-9: anon-created scores were stranded because adoptAnonWork only ran from
    // the keep/discard panel, which only appears when a score is visually on screen.
    // A plain login from a blank canvas must STILL adopt the browser's anon sessions.
    ;(login as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    ;(adoptAnonWork as ReturnType<typeof vi.fn>).mockResolvedValue(0)
    chatMock.abc = undefined // blank canvas — no keep/discard panel
    useAuthStore.setState({ loginOpen: true, oauthProviders: [], csrfToken: 't' })
    const user = userEvent.setup()
    render(<AuthModal />)
    await user.type(screen.getByLabelText('Email'), 'a@b.c')
    await user.type(screen.getByLabelText('Password'), 'longpassword1')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(adoptAnonWork).toHaveBeenCalledTimes(1)
    // Sidebar refreshes so the just-adopted sessions appear, then the modal closes.
    expect(chatMock.refreshSessions).toHaveBeenCalled()
    expect(screen.queryByText('Keep my work')).not.toBeInTheDocument()
    expect(useAuthStore.getState().loginOpen).toBe(false)
  })

  it('does NOT adopt anon work on signup (signup claims the anon identity in place)', async () => {
    ;(signup as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    useAuthStore.setState({ loginOpen: true, mode: 'signup', oauthProviders: [], csrfToken: 't' })
    const user = userEvent.setup()
    render(<AuthModal />)
    await user.type(screen.getByLabelText('Email'), 'new@b.c')
    await user.type(screen.getByLabelText(/^Password/), 'longpassword1')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(adoptAnonWork).not.toHaveBeenCalled()
  })

  it('shows the mapped error and stays open on a failed login', async () => {
    ;(login as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      message: 'Email or password is incorrect.',
    })
    useAuthStore.setState({ loginOpen: true, oauthProviders: [] })
    const user = userEvent.setup()
    render(<AuthModal />)
    await user.type(screen.getByLabelText('Email'), 'a@b.c')
    await user.type(screen.getByLabelText('Password'), 'wrongpass123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/i)
    expect(useAuthStore.getState().loginOpen).toBe(true)
  })

  it('renders only the configured OAuth buttons, each with a brand logo', () => {
    useAuthStore.setState({ loginOpen: true, oauthProviders: ['google'] })
    render(<AuthModal />)
    const google = screen.getByText('Continue with Google').closest('a')
    expect(google).toBeInTheDocument()
    expect(google?.querySelector('svg')).toBeInTheDocument() // Google logo
    expect(screen.queryByText('Continue with GitHub')).not.toBeInTheDocument()
  })

  it('opens on the signup form when mode is signup; submits signup and closes', async () => {
    ;(signup as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    chatMock.abc = 'X:1\nK:C\nCDEF|' // unsaved work — signup adopts it, so NO keep/discard
    useAuthStore.setState({ loginOpen: true, mode: 'signup', oauthProviders: [], csrfToken: 't' })
    const user = userEvent.setup()
    render(<AuthModal />)
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    expect(screen.queryByText('Keep me signed in')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), 'new@b.c')
    // In signup mode the label wraps the "At least 10 characters" hint, so the
    // accessible name is "Password …" — match by prefix.
    await user.type(screen.getByLabelText(/^Password/), 'longpassword1')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(signup).toHaveBeenCalledWith('new@b.c', 'longpassword1')
    expect(login).not.toHaveBeenCalled()
    expect(screen.queryByText('Keep my work')).not.toBeInTheDocument()
    expect(useAuthStore.getState().loginOpen).toBe(false)
  })

  it('toggles between login and signup in place (no navigation)', async () => {
    useAuthStore.setState({ loginOpen: true, mode: 'login', oauthProviders: [] })
    const user = userEvent.setup()
    render(<AuthModal />)
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(useAuthStore.getState().mode).toBe('signup')
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /already have an account/i }))
    expect(useAuthStore.getState().mode).toBe('login')
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument()
  })

  it('login with unsaved work shows keep/discard; closing via × resets it (no stale panel on reopen)', async () => {
    chatMock.abc = 'X:1\nK:C\nCDEF|' // unsaved local work present
    ;(login as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    useAuthStore.setState({ loginOpen: true, oauthProviders: [], csrfToken: 't' })
    const user = userEvent.setup()
    const { rerender } = render(<AuthModal />)
    await user.type(screen.getByLabelText('Email'), 'a@b.c')
    await user.type(screen.getByLabelText('Password'), 'longpassword1')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    // logged in WITH local work → keep/discard panel
    expect(screen.getByText('Keep my work')).toBeInTheDocument()
    // close via the × (NOT "Keep my work")
    await user.click(screen.getByLabelText('Close'))
    expect(useAuthStore.getState().loginOpen).toBe(false)
    // reopen → must show the LOGIN FORM again, not the stale keep/discard panel
    useAuthStore.setState({ loginOpen: true })
    rerender(<AuthModal />)
    expect(screen.queryByText('Keep my work')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
  })
})
