// @vitest-environment node
// jose's webapi build checks `payload instanceof Uint8Array`, which fails
// in jsdom because TextEncoder returns a Uint8Array bound to jsdom's realm
// rather than the Node global realm jose uses. Running in node env keeps
// the prototype chain consistent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../../factories/db'

// In-memory mock of Next's cookie store. Mirrors the subset of methods
// the session helper actually uses.
type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (name: string) => map.get(name),
    set: (name: string, value: string, options?: unknown) => {
      map.set(name, { name, value, options })
    },
    has: (name: string) => map.has(name),
    delete: (name: string) => map.delete(name),
    _reset: () => map.clear(),
  }
})()

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
}))

describe('getOrCreateUserId', () => {
  beforeEach(() => {
    cookieJar._reset()
    // 53 bytes — comfortably above the 32-byte HS256 minimum.
    vi.stubEnv(
      'SESSION_SECRET',
      'test-secret-please-do-not-use-in-production-32+bytes',
    )
    // Recovery secret is required on cookie-mint paths now (Ops 2).
    // Must differ from SESSION_SECRET to exercise the independent-key invariant.
    vi.stubEnv(
      'RECOVERY_SECRET',
      'recovery-test-secret-distinct-from-session-32+bytes-x',
    )
    vi.resetModules()
  })

  afterEach(() => {
    // Undo any stubEnv made by the body so a stray `delete` from one test
    // can't leak into the next.
    vi.unstubAllEnvs()
  })

  it('mints a new user + cookie on first call + returns a recovery token', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId, __TEST_COOKIE_NAME } =
      await import('@/lib/auth/session')
    const { userId, recoveryToken } = await getOrCreateUserId(db)
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(recoveryToken).toBeDefined()
    expect(recoveryToken!.split('.').length).toBe(3) // JWT shape
    const cookie = cookieJar.get(__TEST_COOKIE_NAME)
    expect(cookie).toBeDefined()
    expect(cookie?.value.length ?? 0).toBeGreaterThan(20)
  })

  it('returns the same userId on a second call with the same cookie, and NO recovery token (already backed up)', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const first = await getOrCreateUserId(db)
    const second = await getOrCreateUserId(db)
    expect(second.userId).toBe(first.userId)
    expect(second.recoveryToken).toBeUndefined()
  })

  it('mints a fresh user when the cookie is a garbage string', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId, __TEST_COOKIE_NAME } =
      await import('@/lib/auth/session')
    const first = await getOrCreateUserId(db)
    cookieJar.set(__TEST_COOKIE_NAME, 'not-a-valid-jwt-token-at-all')
    const second = await getOrCreateUserId(db)
    expect(second.userId).not.toBe(first.userId)
    expect(second.recoveryToken).toBeDefined()
  })

  it('mints a fresh user when the JWT was signed with a different secret', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const first = await getOrCreateUserId(db)

    // Re-sign a forged token with a different secret.
    const { SignJWT } = await import('jose')
    const wrongSecret = new TextEncoder().encode(
      'a-completely-different-secret-32-bytes!',
    )
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('attacker-controlled-id')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongSecret)
    cookieJar.set('sl_uid', forged)

    const second = await getOrCreateUserId(db)
    expect(second.userId).not.toBe(first.userId)
    expect(second.userId).not.toBe('attacker-controlled-id')
  })

  it('throws if SESSION_SECRET is unset', async () => {
    const db = makeTestDb()
    vi.stubEnv('SESSION_SECRET', '')
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    await expect(getOrCreateUserId(db)).rejects.toThrow(/SESSION_SECRET/)
  })

  it('throws if SESSION_SECRET is shorter than HS256 minimum (32 bytes)', async () => {
    const db = makeTestDb()
    vi.stubEnv('SESSION_SECRET', 'too-short-secret')
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    await expect(getOrCreateUserId(db)).rejects.toThrow(/SESSION_SECRET/)
  })

  it('mints a fresh user when the JWT has expired', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const first = await getOrCreateUserId(db)

    // Forge a token with the correct secret but a past expiry. Use the same
    // 53-byte secret as beforeEach so the signature matches.
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(
      'test-secret-please-do-not-use-in-production-32+bytes',
    )
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(first.userId) // would have been valid if not expired
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60) // 1 min ago
      .sign(secret)
    cookieJar.set('sl_uid', expired)

    const second = await getOrCreateUserId(db)
    expect(second.userId).not.toBe(first.userId)
  })

  it('mints a fresh user when the JWT references a missing user row', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const first = await getOrCreateUserId(db)

    // Simulate the dormant-user GC having reaped the row.
    const { users } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    db.delete(users).where(eq(users.id, first.userId)).run()

    const second = await getOrCreateUserId(db)
    expect(second.userId).not.toBe(first.userId)
  })

  it('sets the non-httpOnly sl_present sentinel alongside sl_uid', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId, SESSION_PRESENT_COOKIE_NAME } = await import(
      '@/lib/auth/session'
    )
    await getOrCreateUserId(db)
    const sentinel = cookieJar.get(SESSION_PRESENT_COOKIE_NAME)
    expect(sentinel).toBeDefined()
    expect(sentinel?.value).toBe('1')
    // Critical: must be JS-readable (httpOnly:false) so the
    // client-side hasSessionCookie check can see it; the whole point
    // of the sentinel is to short-circuit bootRestoreIfNeeded.
    expect(
      (sentinel?.options as { httpOnly?: boolean } | undefined)?.httpOnly,
    ).toBe(false)
  })
})

describe('getExistingUserId', () => {
  beforeEach(() => {
    cookieJar._reset()
    vi.stubEnv(
      'SESSION_SECRET',
      'test-secret-please-do-not-use-in-production-32+bytes',
    )
    vi.stubEnv(
      'RECOVERY_SECRET',
      'recovery-test-secret-distinct-from-session-32+bytes-x',
    )
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when no cookie is set', async () => {
    const db = makeTestDb()
    const { getExistingUserId } = await import('@/lib/auth/session')
    expect(await getExistingUserId(db)).toBeNull()
  })

  it('returns null when the cookie is garbage', async () => {
    const db = makeTestDb()
    const { getExistingUserId } = await import('@/lib/auth/session')
    cookieJar.set('sl_uid', 'not-a-jwt')
    expect(await getExistingUserId(db)).toBeNull()
  })

  it('returns null when the cookie references a non-existent user row', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId, getExistingUserId } = await import(
      '@/lib/auth/session'
    )
    const { users } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const first = await getOrCreateUserId(db)
    db.delete(users).where(eq(users.id, first.userId)).run()
    expect(await getExistingUserId(db)).toBeNull()
  })

  it('returns the userId when the cookie is valid', async () => {
    const db = makeTestDb()
    const { getOrCreateUserId, getExistingUserId } = await import(
      '@/lib/auth/session'
    )
    const first = await getOrCreateUserId(db)
    const got = await getExistingUserId(db)
    expect(got).toEqual({ userId: first.userId })
  })

  it('never mints a new user', async () => {
    const db = makeTestDb()
    const { getExistingUserId } = await import('@/lib/auth/session')
    const { users } = await import('@/lib/db/schema')
    expect(db.select({ id: users.id }).from(users).all()).toHaveLength(0)
    await getExistingUserId(db)
    // Crucial: no INSERT, no cookie mint. The store should still be empty.
    expect(db.select({ id: users.id }).from(users).all()).toHaveLength(0)
    expect(cookieJar.get('sl_uid')).toBeUndefined()
  })
})

describe('clearSessionCookie', () => {
  beforeEach(() => {
    cookieJar._reset()
    vi.stubEnv(
      'SESSION_SECRET',
      'test-secret-please-do-not-use-in-production-32+bytes',
    )
    vi.stubEnv(
      'RECOVERY_SECRET',
      'recovery-test-secret-distinct-from-session-32+bytes-x',
    )
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('clears BOTH sl_uid and the sl_present sentinel', async () => {
    const db = makeTestDb()
    const {
      getOrCreateUserId,
      clearSessionCookie,
      SESSION_PRESENT_COOKIE_NAME,
    } = await import('@/lib/auth/session')
    await getOrCreateUserId(db)
    expect(cookieJar.get('sl_uid')).toBeDefined()
    expect(cookieJar.get(SESSION_PRESENT_COOKIE_NAME)).toBeDefined()
    await clearSessionCookie()
    expect(cookieJar.get('sl_uid')).toBeUndefined()
    expect(cookieJar.get(SESSION_PRESENT_COOKIE_NAME)).toBeUndefined()
  })
})
