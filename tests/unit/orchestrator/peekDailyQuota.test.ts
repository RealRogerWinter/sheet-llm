// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../../factories/db'
import type { RiskVerdict } from '@/lib/security/ipRisk'

const CLEAR: RiskVerdict = { risky: false, reason: 'clear' }

function cfReq(ip: string): Request {
  return new Request('https://sheetllm.com/api/usage', {
    method: 'GET',
    headers: { 'cf-connecting-ip': ip, 'cf-ray': 'test-ray' },
  })
}

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
  vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '1')
  vi.stubEnv('SL_DAILY_QUOTA_ANON', '5')
  vi.stubEnv('SL_DAILY_QUOTA_FREE', '10')
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
  const { __resetQuotaStateForTesting } = await import('@/lib/orchestrator/dailyQuota')
  __resetQuotaStateForTesting()
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
  vi.unstubAllEnvs()
})

async function seedUser(id: string, emailVerified: 0 | 1, tier = 'free') {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb().insert(users).values({ id, createdAt: 0, lastSeenAt: 0, emailVerified, tier }).run()
}

describe('peekDailyQuota', () => {
  it('reports disabled when the flag is off', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '')
    const { peekDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(peekDailyQuota({ userId: 'anon', authenticated: false }, 'free', cfReq('1.1.1.1'))).toEqual({
      enabled: false,
    })
  })

  it('reports bypass for Pro', async () => {
    await seedUser('p1', 1, 'pro')
    const { peekDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(peekDailyQuota({ userId: 'p1', authenticated: true }, 'pro', cfReq('2.2.2.2'))).toMatchObject({
      enabled: true,
      bypass: true,
    })
  })

  it('a fresh anon shows the full anon allowance and writes NO row (read-only)', async () => {
    const { peekDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(peekDailyQuota({ userId: 'anon', authenticated: false }, 'free', cfReq('3.3.3.3'))).toMatchObject({
      enabled: true,
      isAnon: true,
      limit: 5,
      used: 0,
      remaining: 5,
    })
    const { getDb } = await import('@/lib/db')
    const { requestQuota } = await import('@/lib/db/schema')
    expect(getDb().select().from(requestQuota).all()).toHaveLength(0)
  })

  it('stays consistent with the gate: remaining drops as checkDailyQuota consumes', async () => {
    const { checkDailyQuota, peekDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const req = cfReq('4.4.4.4')
    const inp = { user: { userId: 'anon', authenticated: false }, tier: 'free' as const, request: req, risk: CLEAR }
    expect(checkDailyQuota(inp).ok).toBe(true)
    expect(checkDailyQuota(inp).ok).toBe(true)
    expect(peekDailyQuota({ userId: 'anon', authenticated: false }, 'free', req)).toMatchObject({
      enabled: true,
      limit: 5,
      used: 2,
      remaining: 3,
    })
  })

  it('a verified logged-in free user reads the account allowance (10)', async () => {
    await seedUser('u1', 1, 'free')
    const { peekDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(peekDailyQuota({ userId: 'u1', authenticated: true }, 'free', cfReq('5.5.5.5'))).toMatchObject({
      enabled: true,
      isAnon: false,
      limit: 10,
      remaining: 10,
    })
  })

  it('treats an expired fixed window as a fresh allowance', async () => {
    const { checkDailyQuota, peekDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const req = cfReq('6.6.6.6')
    checkDailyQuota({ user: { userId: 'anon', authenticated: false }, tier: 'free', request: req, risk: CLEAR })
    // Rewind the window so it's well outside the 24h horizon.
    const { getDb } = await import('@/lib/db')
    const { requestQuota } = await import('@/lib/db/schema')
    getDb().update(requestQuota).set({ windowStart: 0 }).run()
    expect(peekDailyQuota({ userId: 'anon', authenticated: false }, 'free', req)).toMatchObject({
      enabled: true,
      used: 0,
      remaining: 5,
    })
  })
})
