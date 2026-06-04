// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../factories/db'

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

async function seed() {
  const { getDb } = await import('@/lib/db')
  const { users, requestQuota } = await import('@/lib/db/schema')
  const db = getDb()
  db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(requestQuota)
    .values([
      { quotaKey: 'u:u1', userId: 'u1', windowStart: 100, count: 3, updatedAt: 100 },
      { quotaKey: 'a:somehash', userId: null, windowStart: 100, count: 2, updatedAt: 100 },
    ])
    .run()
}

describe('GDPR — request_quota', () => {
  it('export includes the user-keyed quota row and excludes anonymous rows', async () => {
    await seed()
    const { getDb } = await import('@/lib/db')
    const { buildUserExport } = await import('@/lib/gdpr/exportUser')
    const exp = await buildUserExport(getDb(), 'u1')
    expect(exp).toBeDefined()
    expect(exp!.dailyQuota).toHaveLength(1)
    expect(exp!.dailyQuota[0].quotaKey).toBe('u:u1')
  })

  it('hardDeleteUser cascade-deletes the user-keyed quota row but leaves anon rows', async () => {
    await seed()
    const { getDb } = await import('@/lib/db')
    const { hardDeleteUser } = await import('@/lib/gdpr/exportUser')
    const { requestQuota } = await import('@/lib/db/schema')
    const res = await hardDeleteUser(getDb(), 'u1')
    expect(res.ok).toBe(true)
    const remaining = getDb()
      .select()
      .from(requestQuota)
      .all()
      .map((r) => r.quotaKey)
    expect(remaining).toEqual(['a:somehash']) // 'u:u1' cascade-deleted; anon row untouched
  })
})
