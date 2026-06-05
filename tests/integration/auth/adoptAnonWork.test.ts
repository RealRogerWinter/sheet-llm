// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'

// Mock the cookie jar (mirrors authRoutes.test.ts) so login mints sl_sess and the
// anon sl_uid persists in the same jar — the exact post-login state this route
// must operate on.
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
  vi.resetModules()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  vi.unstubAllEnvs()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

async function csrf(): Promise<string> {
  const { issueCsrfToken } = await import('@/lib/auth/httpGuards')
  return issueCsrfToken()
}
function post(token: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/auth/adopt-anon-work', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'x-csrf-token': token,
      ...headers,
    },
    body: '{}',
  })
}
async function call(headers: Record<string, string> = {}): Promise<Response> {
  const token = await csrf()
  const { POST } = await import('@/app/api/auth/adopt-anon-work/route')
  return POST(post(token, headers))
}

async function seedSession(id: string, userId: string, deleted = false) {
  const { getDb } = await import('@/lib/db')
  const { sessions } = await import('@/lib/db/schema')
  getDb()
    .insert(sessions)
    .values({ id, userId, createdAt: 1, updatedAt: 1, lastMessageAt: 1, ...(deleted ? { deletedAt: 2 } : {}) })
    .run()
}
async function sessionOwner(id: string): Promise<string | undefined> {
  const { getDb } = await import('@/lib/db')
  const { sessions } = await import('@/lib/db/schema')
  return getDb().select().from(sessions).where(eq(sessions.id, id)).get()?.userId
}
/** Seed a claimed, verified account + a live sl_sess cookie for it. */
async function loginAs(userId: string) {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb()
    .insert(users)
    .values({ id: userId, createdAt: 0, lastSeenAt: 0, email: `${userId}@example.com`, passwordHash: 'h', claimedAt: 1, emailVerified: 1 })
    .onConflictDoNothing()
    .run()
  const { createAuthSession } = await import('@/lib/auth/sessionStore')
  await createAuthSession(userId)
}

describe('POST /api/auth/adopt-anon-work', () => {
  it('migrates the pre-login anon sessions onto the account, skips soft-deleted, consumes sl_uid', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const anon = await getRequestUser() // mints sl_uid + a users row
    const anonId = anon.userId
    expect(cookieJar.get('sl_uid')).toBeDefined()
    await seedSession('s-active', anonId, false)
    await seedSession('s-deleted', anonId, true)

    await loginAs('acct-1') // sets sl_sess; sl_uid remains
    expect(cookieJar.get('sl_sess')).toBeDefined()

    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).migrated).toBe(1)

    expect(await sessionOwner('s-active')).toBe('acct-1') // moved to the account
    expect(await sessionOwner('s-deleted')).toBe(anonId) // soft-deleted left behind
    // The absorbed anon identity is consumed; the auth session is untouched.
    expect(cookieJar.get('sl_uid')).toBeUndefined()
    expect(cookieJar.get('sl_present')).toBeUndefined()
    expect(cookieJar.get('sl_sess')).toBeDefined()
  })

  it('401 when not authenticated (anon only) and migrates nothing', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const anon = await getRequestUser()
    await seedSession('s1', anon.userId)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await sessionOwner('s1')).toBe(anon.userId)
  })

  it('migrated:0 / no change when the anon id IS the account (signup claimed in place)', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const id = (await getRequestUser()).userId
    await seedSession('s1', id)
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb().update(users).set({ email: 'me@example.com', passwordHash: 'h', claimedAt: 1, emailVerified: 1 }).where(eq(users.id, id)).run()
    const { createAuthSession } = await import('@/lib/auth/sessionStore')
    await createAuthSession(id) // sl_uid and sl_sess both resolve to `id`

    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).migrated).toBe(0)
    expect(await sessionOwner('s1')).toBe(id)
  })

  it("refuses a CLAIMED sl_uid — cannot move another claimed account's sessions (no IDOR)", async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const bId = (await getRequestUser()).userId // sl_uid = B
    await seedSession('b-session', bId)
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb().update(users).set({ email: 'b@example.com', passwordHash: 'h', claimedAt: 1, emailVerified: 1 }).where(eq(users.id, bId)).run() // B is now CLAIMED
    await loginAs('acct-A') // logged in as A; sl_uid still points at claimed B

    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).migrated).toBe(0)
    expect(await sessionOwner('b-session')).toBe(bId) // B's session NOT stolen
    expect(cookieJar.get('sl_uid')).toBeDefined() // claimed uid is left intact, not consumed
  })

  it('migrated:0 when there is no anon cookie at all', async () => {
    await loginAs('acct-1') // only sl_sess
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).migrated).toBe(0)
  })

  it('is gated like every auth mutation: 404 accounts-off, 403 cross-origin', async () => {
    await loginAs('acct-1')
    vi.stubEnv('SL_ACCOUNTS_ENABLED', '')
    expect((await call()).status).toBe(404)
    vi.stubEnv('SL_ACCOUNTS_ENABLED', '1')
    expect((await call({ origin: 'http://evil.example' })).status).toBe(403)
  })
})
