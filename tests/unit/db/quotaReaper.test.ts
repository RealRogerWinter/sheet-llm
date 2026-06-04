// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../../factories/db'

const now = () => Math.floor(Date.now() / 1000)
const flush = () => new Promise((r) => setTimeout(r, 0)) // let the reap microtask run

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
  const { __resetForTesting } = await import('@/lib/db/maybeReap')
  __resetForTesting()
  vi.unstubAllEnvs()
})

async function insertRow(quotaKey: string, windowStart: number) {
  const { getDb } = await import('@/lib/db')
  const { requestQuota } = await import('@/lib/db/schema')
  getDb().insert(requestQuota).values({ quotaKey, userId: null, windowStart, count: 1, updatedAt: windowStart }).run()
}
async function rowKeys(): Promise<string[]> {
  const { getDb } = await import('@/lib/db')
  const { requestQuota } = await import('@/lib/db/schema')
  return getDb()
    .select()
    .from(requestQuota)
    .all()
    .map((r) => r.quotaKey)
    .sort()
}

describe('reapExpiredQuotaCounters', () => {
  it('deletes fully-expired rows but never a live or just-closed window', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_WINDOW_SEC', '86400')
    vi.stubEnv('SL_DAILY_QUOTA_RETENTION_GRACE_SEC', '3600')
    const t = now()
    await insertRow('a:live', t - 100) // window still open
    await insertRow('a:justclosed', t - 86400 - 100) // closed, but < grace ago
    await insertRow('a:expired', t - 86400 - 3600 - 100) // past window + grace
    const { reapExpiredQuotaCounters } = await import('@/lib/db/janitor')
    expect(reapExpiredQuotaCounters().reaped).toBe(1)
    expect(await rowKeys()).toEqual(['a:justclosed', 'a:live'])
  })

  it('honors a longer configured window (never reaps a still-open longer window)', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_WINDOW_SEC', '172800') // 48h
    const t = now()
    await insertRow('a:open48', t - 86400) // 24h old — still open under a 48h window
    const { reapExpiredQuotaCounters } = await import('@/lib/db/janitor')
    expect(reapExpiredQuotaCounters().reaped).toBe(0)
    expect(await rowKeys()).toEqual(['a:open48'])
  })
})

describe('maybeReapStaleQuota', () => {
  it('reaps once then throttles until the interval elapses', async () => {
    const t = now()
    await insertRow('a:expired1', t - 200_000)
    const { maybeReapStaleQuota } = await import('@/lib/db/maybeReap')
    maybeReapStaleQuota(60_000)
    await flush()
    expect(await rowKeys()).toEqual([])
    // a second call within the throttle interval schedules nothing
    await insertRow('a:expired2', t - 200_000)
    maybeReapStaleQuota(60_000)
    await flush()
    expect(await rowKeys()).toEqual(['a:expired2'])
  })
})
