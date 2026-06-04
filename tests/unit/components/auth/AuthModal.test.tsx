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
vi.mock('@/lib/auth/authClient', () => ({ login: vi.fn() }))
vi.mock('@/lib/auth/clientBackup', () => ({ clearBackup: vi.fn() }))
// AuthModal only reads useChatStore.getState().abc imperatively.
const chatMock = vi.hoisted(() => ({ abc: undefined as unknown }))
vi.mock('@/lib/chat/state', () => ({ useChatStore: { getState: () => ({ abc: chatMock.abc }) } }))

import AuthModal from '@/components/auth/AuthModal'
import { login } from '@/lib/auth/authClient'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  chatMock.abc = undefined
  useAuthStore.setState({ loginOpen: false, oauthProviders: [], csrfToken: 't' })
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

  it('renders only the configured OAuth buttons', () => {
    useAuthStore.setState({ loginOpen: true, oauthProviders: ['google'] })
    render(<AuthModal />)
    expect(screen.getByText('Continue with Google')).toBeInTheDocument()
    expect(screen.queryByText('Continue with GitHub')).not.toBeInTheDocument()
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
