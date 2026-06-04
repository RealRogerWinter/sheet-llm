import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import QuotaCard from '@/components/chat/QuotaCard'
import { useAuthStore } from '@/lib/auth/authStore'
import type { ChatCta } from '@/lib/shared/types'

// next/link needs app-router context we don't mount in a unit test; render a plain <a>.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

afterEach(cleanup)

const signupCta: ChatCta = {
  kind: 'signup',
  title: "You've used your free requests for today",
  body: 'Create a free account to get more.',
  primaryLabel: 'Create a free account',
  primaryHref: '/signup',
  secondaryLabel: 'Log in',
  secondaryAction: 'openLogin',
  resetsInHours: 24,
}

const loginCta: ChatCta = {
  kind: 'login',
  title: 'Please sign in to continue',
  body: 'This connection looks like a VPN, proxy, or shared host.',
  primaryLabel: 'Log in',
  primaryAction: 'openLogin',
}

describe('QuotaCard', () => {
  it('renders the title/body, a primary link, and the reset hint', () => {
    render(<QuotaCard cta={signupCta} />)
    expect(screen.getByText(signupCta.title)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Create a free account' }).getAttribute('href')).toBe('/signup')
    expect(screen.getByText(/reset in about 24h/i)).toBeTruthy()
  })

  it('opens the auth modal when a primaryAction=openLogin button is clicked', () => {
    useAuthStore.setState({ loginOpen: false })
    render(<QuotaCard cta={loginCta} />)
    expect(useAuthStore.getState().loginOpen).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(useAuthStore.getState().loginOpen).toBe(true)
  })

  it('omits the reset hint when resetsInHours is absent (login gate)', () => {
    render(<QuotaCard cta={loginCta} />)
    expect(screen.queryByText(/reset in about/i)).toBeNull()
  })
})
