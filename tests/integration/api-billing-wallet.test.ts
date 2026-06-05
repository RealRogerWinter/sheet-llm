// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditWallet, placeHold } from '@/lib/billing/wallet'

/**
 * GET /api/billing/wallet — the read route behind the wallet UI (PR-12). Proves
 * the surface gate (off for self-host), the auth gate, and that it reads the
 * balance read-only (no mint).
 */

const cfg = vi.hoisted(() => ({ userId: '00000000-0000-0000-0000-000000000001', authenticated: true }))

vi.mock('@/lib/auth/session', () => ({
  getExistingRequestUser: async () => (cfg.authenticated ? { userId: cfg.userId, authenticated: true } : null),
  getRequestUser: async () => ({ userId: cfg.userId, authenticated: cfg.authenticated }),
}))

const { GET } = await import('@/app/api/billing/wallet/route')

describe('GET /api/billing/wallet', () => {
  installTestDb()
  beforeEach(() => {
    cfg.userId = TEST_USER_ID
    cfg.authenticated = true
  })
  afterEach(() => vi.unstubAllEnvs())

  it('404s when the billing surface is off (no Stripe, no paid generation) — self-host sees nothing', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    vi.stubEnv('SL_PAID_GENERATION', '')
    const res = await GET()
    expect(res.status).toBe(404)
  })

  it('is enabled by SL_PAID_GENERATION alone (spend-only, no Stripe)', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    vi.stubEnv('SL_PAID_GENERATION', '1')
    const res = await GET()
    expect(res.status).toBe(200)
  })

  it('401s when not authenticated, even with billing on', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    cfg.authenticated = false
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns balance/held/available for an authenticated user', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1050, source: 'stripe' })
    placeHold({ userId: TEST_USER_ID, requestId: 'r1', idempotencyKey: 'k1', credits: 50 })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: 1050, held: 50, available: 1000 })
  })

  it('reads 0/0/0 for a user with no wallet — never mints a wallet row on a read', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: 0, held: 0, available: 0 })
  })
})
