// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditHolds, usageLedger } from '@/lib/db/schema'

/**
 * PR-13 — the chokepoint FAIL-POLICY test (red-team should-fix). The paid path
 * must fail CLOSED on a wallet / DB FAULT (not just on insufficient balance): if
 * placeHold throws, the request is REFUSED, never served as an uncharged
 * generation. The main paywall suite covers the insufficient / below-floor /
 * legacy-bypass fail-closed paths with the real wallet; this file mocks placeHold
 * to THROW so it can exercise the route's catch block (route.ts hold block),
 * which the other tests can't reach with a healthy wallet.
 */

const cfg = vi.hoisted(() => ({ runCalls: 0 }))

vi.mock('@/lib/auth/session', () => ({
  getRequestUser: async () => ({ userId: '00000000-0000-0000-0000-000000000001', authenticated: true }),
  getExistingRequestUser: async () => ({ userId: '00000000-0000-0000-0000-000000000001', authenticated: true }),
}))

// Partial wallet mock: ensureWallet / getWallet / creditWallet stay REAL (so the
// balance read passes the start-gate floor), but placeHold THROWS to simulate a
// transient DB / wallet fault at the exact reservation chokepoint.
vi.mock('@/lib/billing/wallet', async (orig) => {
  const actual = await orig<typeof import('@/lib/billing/wallet')>()
  return {
    ...actual,
    placeHold: () => {
      throw new Error('simulated wallet/DB failure')
    },
  }
})

// run() must NEVER be reached on a fail-closed refusal — count its calls.
vi.mock('@/lib/orchestrator', async (orig) => {
  const actual = await orig<typeof import('@/lib/orchestrator')>()
  return {
    ...actual,
    run: async () => {
      cfg.runCalls++
      return null
    },
  }
})

const { POST } = await import('@/app/api/chat/route')
const { creditWallet, getWallet } = await import('@/lib/billing/wallet')

function postChat(message: string) {
  return POST(
    new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ message, debug: { orchestrator: 'on' } }),
    }),
  )
}

describe('/api/chat paid path fails CLOSED on a wallet fault (PR-13)', () => {
  installTestDb()
  beforeEach(() => {
    cfg.runCalls = 0
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
    vi.stubEnv('SL_PAID_GENERATION', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('a thrown placeHold REFUSES (500) and never dispatches or charges', async () => {
    // Fund well above the worst-case floor so the start gate passes and execution
    // reaches placeHold — which then throws.
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 5000, source: 'test' })

    const res = await postChat('compose a melody')

    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('internal_error')
    expect(cfg.runCalls).toBe(0) // never served an uncharged generation
    // No money moved, no hold stranded.
    expect(getWallet(TEST_USER_ID)).toEqual({ balance: 5000, held: 0, available: 5000 })
    const { getDb } = await import('@/lib/db')
    expect(getDb().select().from(creditHolds).all().length).toBe(0)
    expect(getDb().select().from(usageLedger).all().length).toBe(0)
  })
})
