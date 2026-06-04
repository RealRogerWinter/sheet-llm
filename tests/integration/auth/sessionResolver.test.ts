// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'

// Shared in-memory cookie jar (same shape as restore.test.ts).
type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (name: string) => map.get(name),
    set: (name: string, value: string, options?: unknown) =>
      map.set(name, { name, value, options }),
    has: (name: string) => map.has(name),
    delete: (name: string) => map.delete(name),
    _reset: () => map.clear(),
  }
})()

vi.mock('next/headers', () => ({ cookies: async () => cookieJar }))

beforeEach(async () => {
  cookieJar._reset()
  vi.stubEnv('SESSION_SECRET', 'test-secret-please-do-not-use-in-production-32+bytes')
  vi.stubEnv('RECOVERY_SECRET', 'recovery-test-secret-distinct-from-session-32+bytes-x')
  vi.resetModules()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

async function claim(userId: string, fields: Record<string, unknown> = { claimedAt: 1 }) {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb().update(users).set(fields).where(eq(users.id, userId)).run()
}

describe('getRequestUser', () => {
  it('mints a fresh anon identity (+recovery) when there is no cookie', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const u = await getRequestUser()
    expect(u.userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.authenticated).toBe(false)
    expect(u.recoveryToken).toBeTruthy()
    expect(cookieJar.get('sl_uid')).toBeDefined()
  })

  it('returns the SAME anon identity on a second call — no re-mint, no recovery', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const first = await getRequestUser()
    const second = await getRequestUser()
    expect(second.userId).toBe(first.userId)
    expect(second.authenticated).toBe(false)
    expect(second.recoveryToken).toBeUndefined()
  })

  it('a valid sl_sess resolves the authenticated account WITHOUT minting sl_uid or recovery', async () => {
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const userId = '11111111-1111-1111-1111-111111111111'
    getDb()
      .insert(users)
      .values({ id: userId, createdAt: 0, lastSeenAt: 0, email: 'a@b.c', claimedAt: 1 })
      .run()
    const { createAuthSession } = await import('@/lib/auth/sessionStore')
    await createAuthSession(userId)
    expect(cookieJar.get('sl_sess')).toBeDefined()
    expect(cookieJar.get('sl_auth')).toBeDefined()
    expect(cookieJar.get('sl_uid')).toBeUndefined()

    const { getRequestUser } = await import('@/lib/auth/session')
    const u = await getRequestUser()
    expect(u.userId).toBe(userId)
    expect(u.authenticated).toBe(true)
    expect(u.recoveryToken).toBeUndefined()
    // The authenticated path must NOT mint an anonymous sl_uid.
    expect(cookieJar.get('sl_uid')).toBeUndefined()
  })

  it('REFUSES a stale sl_uid pointing at a CLAIMED account → mints a fresh anon instead', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    const anon = await getRequestUser()
    // The sl_uid now points at this user; claim it (email+password+claimed_at).
    await claim(anon.userId, { email: 'x@y.z', passwordHash: 'h', claimedAt: 1 })
    // A stale sl_uid for a claimed account is an unrevocable passwordless bearer
    // credential — the resolver must NOT return the account.
    const after = await getRequestUser()
    expect(after.userId).not.toBe(anon.userId)
    expect(after.authenticated).toBe(false)
    expect(after.recoveryToken).toBeTruthy()
  })

  it('prefers a valid sl_sess (user A) over a valid sl_uid (user B)', async () => {
    const { getRequestUser } = await import('@/lib/auth/session')
    // Mint an anon (user B) → sets sl_uid.
    const b = await getRequestUser()
    // Seed user A + an sl_sess for A; the sl_uid for B is left in place.
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const aId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    getDb().insert(users).values({ id: aId, createdAt: 0, lastSeenAt: 0 }).run()
    const { createAuthSession } = await import('@/lib/auth/sessionStore')
    await createAuthSession(aId)
    // Both sl_sess (A) and sl_uid (B) present — the exact downgrade an attacker
    // would attempt. Must resolve to the sl_sess account, never the sl_uid one.
    expect(cookieJar.get('sl_uid')).toBeDefined()
    const resolved = await getRequestUser()
    expect(resolved.userId).toBe(aId)
    expect(resolved.authenticated).toBe(true)
    expect(resolved.userId).not.toBe(b.userId)
  })
})

describe('getExistingRequestUser', () => {
  it('returns null for a claimed sl_uid (must log in)', async () => {
    const { getRequestUser, getExistingRequestUser } = await import('@/lib/auth/session')
    const anon = await getRequestUser()
    await claim(anon.userId)
    expect(await getExistingRequestUser()).toBeNull()
  })

  it('returns the anon user for an unclaimed sl_uid, and never mints', async () => {
    const { getRequestUser, getExistingRequestUser } = await import('@/lib/auth/session')
    const anon = await getRequestUser()
    const existing = await getExistingRequestUser()
    expect(existing?.userId).toBe(anon.userId)
    expect(existing?.authenticated).toBe(false)
  })

  it('returns null with no session, minting nothing', async () => {
    const { getExistingRequestUser } = await import('@/lib/auth/session')
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    expect(await getExistingRequestUser()).toBeNull()
    expect(getDb().select({ id: users.id }).from(users).all()).toHaveLength(0)
  })
})

describe('sessionStore (DB-backed sl_sess)', () => {
  async function seedUserWithSession(userId = '22222222-2222-2222-2222-222222222222') {
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb().insert(users).values({ id: userId, createdAt: 0, lastSeenAt: 0 }).run()
    const { createAuthSession } = await import('@/lib/auth/sessionStore')
    const { id } = await createAuthSession(userId)
    return { userId, sessionId: id }
  }

  it('createAuthSession + verifyAuthSession round-trip', async () => {
    const { userId } = await seedUserWithSession()
    const { verifyAuthSession } = await import('@/lib/auth/sessionStore')
    expect((await verifyAuthSession())?.userId).toBe(userId)
  })

  it('verifyAuthSession returns null after revokeCurrentAuthSession (and clears cookies)', async () => {
    await seedUserWithSession()
    const { verifyAuthSession, revokeCurrentAuthSession } = await import('@/lib/auth/sessionStore')
    await revokeCurrentAuthSession()
    expect(await verifyAuthSession()).toBeNull()
    expect(cookieJar.get('sl_sess')).toBeUndefined()
    expect(cookieJar.get('sl_auth')).toBeUndefined()
  })

  it('verifyAuthSession returns null for an absolutely-expired session', async () => {
    const { sessionId } = await seedUserWithSession()
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    getDb().update(authSessions).set({ expiresAt: 1 }).where(eq(authSessions.id, sessionId)).run()
    const { verifyAuthSession } = await import('@/lib/auth/sessionStore')
    expect(await verifyAuthSession()).toBeNull()
  })

  it('verifyAuthSession returns null for an idle-expired session', async () => {
    const { sessionId } = await seedUserWithSession()
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    getDb().update(authSessions).set({ idleExpiresAt: 1 }).where(eq(authSessions.id, sessionId)).run()
    const { verifyAuthSession } = await import('@/lib/auth/sessionStore')
    expect(await verifyAuthSession()).toBeNull()
  })

  it('revokeAllAuthSessions revokes every live session for the user', async () => {
    const { userId } = await seedUserWithSession()
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    // A second, independent live session for the same user.
    getDb()
      .insert(authSessions)
      .values({
        id: 'sess-2',
        userId,
        tokenHash: 'second-hash',
        createdAt: 1,
        expiresAt: 9_999_999_999,
        idleExpiresAt: 9_999_999_999,
        lastUsedAt: 1,
      })
      .run()
    const { revokeAllAuthSessions } = await import('@/lib/auth/sessionStore')
    expect(await revokeAllAuthSessions(userId)).toBe(2)
    const rows = getDb().select().from(authSessions).where(eq(authSessions.userId, userId)).all()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true)
  })

  it('slides idle expiry when stale (>1h) but not within the throttle window', async () => {
    const { sessionId } = await seedUserWithSession()
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    const { verifyAuthSession } = await import('@/lib/auth/sessionStore')
    const before = getDb().select().from(authSessions).where(eq(authSessions.id, sessionId)).get()
    // Fresh (last_used_at = now): verify must NOT bump (write-amplification cap).
    await verifyAuthSession()
    const afterFresh = getDb().select().from(authSessions).where(eq(authSessions.id, sessionId)).get()
    expect(afterFresh?.idleExpiresAt).toBe(before?.idleExpiresAt)
    // Stale (last_used_at 2h ago): verify SHOULD slide idle forward.
    const now = Math.floor(Date.now() / 1000)
    getDb()
      .update(authSessions)
      .set({ lastUsedAt: now - 2 * 3600, idleExpiresAt: now - 2 * 3600 + 14 * 86400 })
      .where(eq(authSessions.id, sessionId))
      .run()
    const staleIdle =
      getDb().select().from(authSessions).where(eq(authSessions.id, sessionId)).get()?.idleExpiresAt ?? 0
    await verifyAuthSession()
    const afterStale = getDb().select().from(authSessions).where(eq(authSessions.id, sessionId)).get()
    expect(afterStale?.idleExpiresAt ?? 0).toBeGreaterThan(staleIdle)
  })

  it('remember-me off clamps the absolute expiry to ~12h', async () => {
    const { getDb } = await import('@/lib/db')
    const { users, authSessions } = await import('@/lib/db/schema')
    const userId = '33333333-3333-3333-3333-333333333333'
    getDb().insert(users).values({ id: userId, createdAt: 0, lastSeenAt: 0 }).run()
    const { createAuthSession } = await import('@/lib/auth/sessionStore')
    const now = Math.floor(Date.now() / 1000)
    const { id } = await createAuthSession(userId, { rememberMe: false })
    const row = getDb().select().from(authSessions).where(eq(authSessions.id, id)).get()
    expect(row).toBeDefined()
    expect((row?.expiresAt ?? 0) - now).toBeLessThanOrEqual(12 * 3600 + 5)
    expect((row?.expiresAt ?? 0) - now).toBeGreaterThan(11 * 3600)
    expect(row?.idleExpiresAt ?? 0).toBeLessThanOrEqual(row?.expiresAt ?? 0)
  })
})
