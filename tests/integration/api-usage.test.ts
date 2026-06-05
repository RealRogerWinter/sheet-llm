// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../factories/db'

type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (n: string) => map.get(n),
    set: (n: string, v: string, o?: unknown) => map.set(n, { name: n, value: v, options: o }),
    has: (n: string) => map.has(n),
    delete: (n: string) => map.delete(n),
    _reset: () => map.clear(),
  }
})()
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }))

beforeEach(async () => {
  cookieJar._reset()
  vi.stubEnv('SESSION_SECRET', 'test-secret-please-do-not-use-in-production-32+bytes')
  vi.stubEnv('RECOVERY_SECRET', 'recovery-test-secret-distinct-from-session-32+bytes-x')
  vi.stubEnv('SL_ACCOUNTS_ENABLED', '1')
  vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '1')
  vi.stubEnv('SL_DAILY_QUOTA_ANON', '5')
  vi.stubEnv('SL_DAILY_QUOTA_FREE', '10')
  vi.resetModules()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
  const { __resetQuotaStateForTesting } = await import('@/lib/orchestrator/dailyQuota')
  __resetQuotaStateForTesting()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

function get(headers: Record<string, string> = {}): Request {
  return new Request('https://sheetllm.com/api/usage', {
    method: 'GET',
    headers: { 'cf-connecting-ip': '7.7.7.7', 'cf-ray': 'test-ray', host: 'sheetllm.com', ...headers },
  })
}
async function callUsage(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/usage/route')
  const res = await GET(get(headers))
  return { res, body: await res.json() }
}
async function loginAs(userId: string, tier = 'free') {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb()
    .insert(users)
    .values({ id: userId, createdAt: 0, lastSeenAt: 0, email: `${userId}@example.com`, passwordHash: 'h', claimedAt: 1, emailVerified: 1, tier })
    .onConflictDoNothing()
    .run()
  const { createAuthSession } = await import('@/lib/auth/sessionStore')
  await createAuthSession(userId)
}

describe('GET /api/usage', () => {
  it('anonymous, quota on: returns the full anon daily allowance and mints NO identity', async () => {
    const { body } = await callUsage()
    expect(body.authenticated).toBe(false)
    expect(body.daily).toMatchObject({ remaining: 5, limit: 5, used: 0 })
    expect(body.credits).toBeNull()
    // Read-only: a usage check must not mint an anonymous session.
    expect(cookieJar.get('sl_uid')).toBeUndefined()
    // No instance-level feature flags echoed to an anonymous caller.
    expect(body).not.toHaveProperty('quotaEnabled')
    expect(body).not.toHaveProperty('billingEnabled')
  })

  it('quota off: daily is null', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '')
    const { body } = await callUsage()
    expect(body.daily).toBeNull()
  })

  it('verified logged-in free user: daily uses the account allowance (10), no credits when billing off', async () => {
    await loginAs('u1', 'free')
    const { body } = await callUsage()
    expect(body.authenticated).toBe(true)
    expect(body.daily).toMatchObject({ remaining: 10, limit: 10 })
    expect(body.credits).toBeNull()
  })

  it('Pro with the billing surface on: returns credit balance and no daily quota', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    vi.stubEnv('SL_PAID_GENERATION', '1')
    await loginAs('pro1', 'pro')
    const { getDb } = await import('@/lib/db')
    const { creditWallets } = await import('@/lib/db/schema')
    getDb().insert(creditWallets).values({ userId: 'pro1', balance: 500, held: 0, version: 0, updatedAt: 0 }).run()

    const { body } = await callUsage()
    expect(body.tier).toBe('pro')
    expect(body.daily).toBeNull() // Pro bypasses the daily quota
    expect(body.credits).toBe(500)
  })
})
