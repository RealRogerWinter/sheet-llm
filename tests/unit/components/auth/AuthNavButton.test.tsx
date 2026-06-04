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
vi.mock('@/lib/auth/authClient', () => ({ logout: vi.fn(async () => ({ ok: true })) }))

import AuthNavButton from '@/components/auth/AuthNavButton'

afterEach(() => {
  cleanup()
  useAuthStore.setState({ status: 'loading', email: null, loginOpen: false, mode: 'login' })
})

describe('AuthNavButton', () => {
  it('renders nothing while loading or disabled', () => {
    useAuthStore.setState({ status: 'loading' })
    const { container, rerender } = render(<AuthNavButton />)
    expect(container).toBeEmptyDOMElement()
    useAuthStore.setState({ status: 'disabled' })
    rerender(<AuthNavButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows Log in + Sign up when anon; Log in opens the modal on the login form', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ status: 'anon' })
    render(<AuthNavButton />)
    expect(screen.getByText('Log in')).toBeInTheDocument()
    expect(screen.getByText('Sign up')).toBeInTheDocument()
    await user.click(screen.getByText('Log in'))
    expect(useAuthStore.getState().loginOpen).toBe(true)
    expect(useAuthStore.getState().mode).toBe('login')
  })

  it('Sign up opens the modal on the signup form (no navigation to /signup)', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ status: 'anon' })
    render(<AuthNavButton />)
    const signupBtn = screen.getByText('Sign up')
    expect(signupBtn.tagName).toBe('BUTTON') // a button, not an <a href="/signup">
    await user.click(signupBtn)
    expect(useAuthStore.getState().loginOpen).toBe(true)
    expect(useAuthStore.getState().mode).toBe('signup')
  })

  it('shows the email + Log out when authed; Log out calls logout()', async () => {
    const { logout } = await import('@/lib/auth/authClient')
    const user = userEvent.setup()
    useAuthStore.setState({ status: 'authed', email: 'a@b.c' })
    render(<AuthNavButton />)
    expect(screen.getByText('a@b.c')).toBeInTheDocument()
    await user.click(screen.getByText('Log out'))
    expect(logout).toHaveBeenCalledTimes(1)
  })
})
