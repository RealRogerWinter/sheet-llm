import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import WalletSettings from '@/components/billing/WalletSettings'
import { useAuthStore } from '@/lib/auth/authStore'

vi.mock('@/lib/billing/billingClient', () => ({
  fetchWallet: vi.fn(),
  fetchPacks: vi.fn(),
  fetchTransactions: vi.fn(),
  startCheckout: vi.fn(),
}))
import { fetchPacks, fetchTransactions, fetchWallet, startCheckout } from '@/lib/billing/billingClient'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/settings') // reset the URL between tests
})

function setAuth(status: 'loading' | 'anon' | 'authed', emailVerified = true) {
  useAuthStore.setState({ status, emailVerified })
}

describe('WalletSettings', () => {
  beforeEach(() => {
    // Balance distinct from any pack's credits (1050) so "1,234 credits" is unambiguous.
    vi.mocked(fetchWallet).mockResolvedValue({ balance: 1234, held: 0, available: 1234 })
    vi.mocked(fetchPacks).mockResolvedValue([
      { id: 'pack_10', label: 'Plus', priceUsdCents: 1000, credits: 1050, bonusCredits: 50 },
    ])
    vi.mocked(fetchTransactions).mockResolvedValue([
      { id: 'l1', creditsDelta: -23, type: 'generation', description: 'Generation', amountMinorUsd: null, createdAt: 1_700_000_000 },
    ])
    vi.mocked(startCheckout).mockResolvedValue({ ok: true })
  })

  it('renders nothing when the user is not authenticated', () => {
    setAuth('anon')
    const { container } = render(<WalletSettings />)
    expect(container.firstChild).toBeNull()
    expect(fetchWallet).not.toHaveBeenCalled()
  })

  it('renders nothing when the wallet fetch 404s (billing surface off)', async () => {
    setAuth('authed')
    vi.mocked(fetchWallet).mockResolvedValue(null)
    const { container } = render(<WalletSettings />)
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('shows the credit balance with the USD hint (HYBRID display)', async () => {
    setAuth('authed')
    render(<WalletSettings />)
    expect(await screen.findByText('1,234 credits')).toBeTruthy()
    expect(screen.getByText('≈ $12.34')).toBeTruthy()
  })

  it('shows packs and starts Stripe checkout on click', async () => {
    setAuth('authed')
    render(<WalletSettings />)
    const buy = await screen.findByRole('button', { name: /Plus/ })
    fireEvent.click(buy)
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith('pack_10'))
  })

  it('disables purchasing and hints when the email is unverified', async () => {
    setAuth('authed', false)
    render(<WalletSettings />)
    await screen.findByText('1,234 credits')
    expect(screen.getByText(/Verify your email/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Plus/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides the buy block when packs are unavailable (Stripe not configured)', async () => {
    setAuth('authed')
    vi.mocked(fetchPacks).mockResolvedValue(null)
    render(<WalletSettings />)
    await screen.findByText('1,234 credits')
    expect(screen.queryByText('Add credits')).toBeNull()
  })

  it('renders recent activity with a signed delta (a spend shows negative)', async () => {
    setAuth('authed')
    render(<WalletSettings />)
    expect(await screen.findByText('Generation')).toBeTruthy()
    expect(screen.getByText(/[−-]23/)).toBeTruthy()
  })

  it('surfaces a checkout=success return and strips the ?checkout param', async () => {
    window.history.replaceState(null, '', '/settings?checkout=success')
    setAuth('authed')
    render(<WalletSettings />)
    expect(await screen.findByText(/Payment received/i)).toBeTruthy()
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('surfaces a checkout=cancel return', async () => {
    window.history.replaceState(null, '', '/settings?checkout=cancel')
    setAuth('authed')
    render(<WalletSettings />)
    expect(await screen.findByText(/Checkout canceled/i)).toBeTruthy()
    await waitFor(() => expect(window.location.search).toBe(''))
  })
})
