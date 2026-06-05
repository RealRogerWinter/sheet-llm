// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditPurchases, usageLedger } from '@/lib/db/schema'

/**
 * GET /api/billing/transactions — the recent-activity feed behind the wallet UI
 * (PR-12). Proves the surface + auth gates and the merged read shape.
 */

const cfg = vi.hoisted(() => ({ userId: '00000000-0000-0000-0000-000000000001', authenticated: true }))

vi.mock('@/lib/auth/session', () => ({
  getExistingRequestUser: async () => (cfg.authenticated ? { userId: cfg.userId, authenticated: true } : null),
  getRequestUser: async () => ({ userId: cfg.userId, authenticated: cfg.authenticated }),
}))

const { GET } = await import('@/app/api/billing/transactions/route')

async function seed(): Promise<void> {
  const { getDb } = await import('@/lib/db')
  const db = getDb()
  db.insert(creditPurchases)
    .values({
      id: 'p1',
      userId: TEST_USER_ID,
      source: 'stripe',
      creditsDelta: 1050,
      amountMinorUsd: 1000,
      currency: 'usd',
      status: 'settled',
      externalRef: 'cs_test',
      createdAt: 100,
    })
    .run()
  db.insert(usageLedger)
    .values({
      id: 'l1',
      userId: TEST_USER_ID,
      requestId: 'r1',
      idempotencyKey: 'k1',
      kind: 'chat_generate',
      creditsCharged: 23,
      createdAt: 200,
    })
    .run()
}

describe('GET /api/billing/transactions', () => {
  installTestDb()
  beforeEach(() => {
    cfg.userId = TEST_USER_ID
    cfg.authenticated = true
  })
  afterEach(() => vi.unstubAllEnvs())

  it('404s when the billing surface is off', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    vi.stubEnv('SL_PAID_GENERATION', '')
    expect((await GET()).status).toBe(404)
  })

  it('401s when not authenticated', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    cfg.authenticated = false
    expect((await GET()).status).toBe(401)
  })

  it('returns the merged activity feed newest-first for the user', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    await seed()
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { transactions: Array<{ id: string; creditsDelta: number; type: string }> }
    expect(body.transactions.map((t) => t.id)).toEqual(['l1', 'p1'])
    expect(body.transactions[0]).toMatchObject({ type: 'generation', creditsDelta: -23 })
    expect(body.transactions[1]).toMatchObject({ type: 'purchase', creditsDelta: 1050, amountMinorUsd: 1000 })
  })

  it('returns an empty feed for a user with no activity', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).transactions).toEqual([])
  })
})
