import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useAuthStore } from '@/lib/auth/authStore'

vi.mock('@/lib/auth/authClient', () => ({
  changePassword: vi.fn(async () => ({ ok: true })),
  changeEmail: vi.fn(async () => ({ ok: true })),
  fetchSessions: vi.fn(async () => []),
  logoutAllDevices: vi.fn(async () => ({ ok: true })),
  resendVerification: vi.fn(async () => ({ ok: true })),
  revokeSession: vi.fn(async () => ({ ok: true })),
}))

import AccountSettings from '@/components/auth/AccountSettings'
import { changePassword, fetchSessions, revokeSession } from '@/lib/auth/authClient'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAuthStore.setState({ status: 'loading', email: null, emailVerified: false })
})

describe('AccountSettings', () => {
  it('renders nothing for an anonymous (or loading) user', () => {
    useAuthStore.setState({ status: 'anon' })
    const { container } = render(<AccountSettings />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the account section + verified email for an authed user', () => {
    useAuthStore.setState({ status: 'authed', email: 'a@b.c', emailVerified: true })
    render(<AccountSettings />)
    expect(screen.getByText('Account')).toBeInTheDocument()
    expect(screen.getByText(/a@b\.c/)).toBeInTheDocument()
    expect(screen.getByText('verified')).toBeInTheDocument()
  })

  it('offers "Resend verification" when the email is unverified', () => {
    useAuthStore.setState({ status: 'authed', email: 'a@b.c', emailVerified: false })
    render(<AccountSettings />)
    expect(screen.getByText('unverified')).toBeInTheDocument()
    expect(screen.getByText('Resend verification')).toBeInTheDocument()
  })

  it('submits change-password with the current + new password', async () => {
    useAuthStore.setState({ status: 'authed', email: 'a@b.c', emailVerified: true })
    const user = userEvent.setup()
    render(<AccountSettings />)
    await user.type(screen.getByLabelText('Current password'), 'old-pass-1234')
    await user.type(screen.getByLabelText('New password'), 'new-pass-12345')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(changePassword).toHaveBeenCalledWith('old-pass-1234', 'new-pass-12345')
  })

  it('lists sessions and revokes a non-current one', async () => {
    ;(fetchSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 's1', createdAt: 0, lastUsedAt: 0, userAgent: 'Firefox on Linux', ip: null, current: false },
      { id: 's2', createdAt: 0, lastUsedAt: 0, userAgent: 'this-device-ua', ip: null, current: true },
    ])
    useAuthStore.setState({ status: 'authed', email: 'a@b.c', emailVerified: true })
    const user = userEvent.setup()
    render(<AccountSettings />)
    expect(await screen.findByText('Firefox on Linux')).toBeInTheDocument()
    expect(screen.getByText('This device')).toBeInTheDocument() // current row label
    await user.click(screen.getByText('Sign out')) // only the non-current row has it
    expect(revokeSession).toHaveBeenCalledWith('s1')
  })
})
