// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'

// In-memory cookie store mock (shared with session.test.ts shape).
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

beforeEach(async () => {
  cookieJar._reset()
  vi.stubEnv('SESSION_SECRET', 'test-secret-please-do-not-use-in-production-32+bytes')
  vi.stubEnv(
    'RECOVERY_SECRET',
    'recovery-test-secret-distinct-from-session-32+bytes-x',
  )
  vi.resetModules()
  // Wipe rate limiter between tests.
  const { __resetForTesting } = await import('@/lib/auth/restoreRateLimit')
  __resetForTesting()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

function restoreReq(token: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/auth/restore', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      ...headers,
    },
    body: JSON.stringify({ token }),
  })
}

async function seedUserAndGetToken(): Promise<{ userId: string; token: string }> {
  // Force a cookie-mint by calling getOrCreateUserId fresh — returns a
  // recovery token we can replay against /restore.
  const { getOrCreateUserId } = await import('@/lib/auth/session')
  const session = await getOrCreateUserId()
  if (!session.recoveryToken) throw new Error('expected recovery token on mint')
  return { userId: session.userId, token: session.recoveryToken }
}

describe('POST /api/auth/restore', () => {
  it('204s on a valid first-use token + sets new cookie + emits new recovery header', async () => {
    const { userId, token } = await seedUserAndGetToken()
    // Wipe the cookie so the restore endpoint actually has work to do.
    cookieJar._reset()

    const { POST } = await import('@/app/api/auth/restore/route')
    const res = await POST(restoreReq(token))
    expect(res.status).toBe(204)
    expect(res.headers.get('X-Session-Recovery')).toBeTruthy()
    // Cookie was re-issued (mock cookieStore tracks the .set).
    expect(cookieJar.get('sl_uid')).toBeDefined()
    // Recovery token rotation: new token is different from the one we
    // just used.
    expect(res.headers.get('X-Session-Recovery')).not.toBe(token)
    // userId variable kept for documentation — not asserted further;
    // the cookie value carries it via JWT sub.
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('401s on a token signed with the wrong secret', async () => {
    const { SignJWT } = await import('jose')
    const wrongSecret = new TextEncoder().encode(
      'a-completely-different-recovery-secret-32-bytes-x',
    )
    const forged = await new SignJWT({ nonce: 'fake-nonce' })
      .setProtectedHeader({ alg: 'HS256', kid: 'r1' })
      .setSubject('00000000-0000-0000-0000-000000000000')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongSecret)
    const { POST } = await import('@/app/api/auth/restore/route')
    const res = await POST(restoreReq(forged))
    expect(res.status).toBe(401)
  })

  it('401s on an expired token', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(
      'recovery-test-secret-distinct-from-session-32+bytes-x',
    )
    const expired = await new SignJWT({ nonce: 'n1' })
      .setProtectedHeader({ alg: 'HS256', kid: 'r1' })
      .setSubject('00000000-0000-0000-0000-000000000000')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret)
    const { POST } = await import('@/app/api/auth/restore/route')
    const res = await POST(restoreReq(expired))
    expect(res.status).toBe(401)
  })

  it('410s when the user row no longer exists (GC or /me/delete)', async () => {
    const { userId, token } = await seedUserAndGetToken()
    // Delete the user — simulates dormant-user GC.
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb().delete(users).where(eq(users.id, userId)).run()

    const { POST } = await import('@/app/api/auth/restore/route')
    const res = await POST(restoreReq(token))
    expect(res.status).toBe(410)
  })

  it('409s on replay of a previously consumed token', async () => {
    const { token } = await seedUserAndGetToken()
    cookieJar._reset()
    const { POST } = await import('@/app/api/auth/restore/route')
    const first = await POST(restoreReq(token))
    expect(first.status).toBe(204)
    // Replay the SAME token — second call must reject.
    const second = await POST(restoreReq(token))
    expect(second.status).toBe(409)
  })

  it('409 account_claimed once the identity is upgraded to a real account', async () => {
    const { userId, token } = await seedUserAndGetToken()
    cookieJar._reset()
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    // Simulate the anon->account claim (PR-3/4 do this on signup): email +
    // password_hash + claimed_at land on the EXISTING anon user row.
    getDb()
      .update(users)
      .set({
        email: 'owner@example.com',
        passwordHash: 'argon2id$fake',
        claimedAt: 1781500000,
      })
      .where(eq(users.id, userId))
      .run()

    const { POST } = await import('@/app/api/auth/restore/route')
    const res = await POST(restoreReq(token))
    // The anonymous recovery path is CLOSED for a claimed account — a leaked
    // localStorage recovery token must not be a passwordless login.
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('account_claimed')
    // No session cookie was re-issued...
    expect(cookieJar.get('sl_uid')).toBeUndefined()
    // ...and the nonce was NOT consumed (the CAS predicate excluded the claimed
    // row), so a future legitimate flow isn't poisoned.
    expect(
      getDb()
        .select({ nonce: users.lastRecoveryNonce })
        .from(users)
        .where(eq(users.id, userId))
        .get()?.nonce ?? null,
    ).toBeNull()
  })

  it('account_claimed takes precedence over replay for a claimed row', async () => {
    const { userId, token } = await seedUserAndGetToken()
    cookieJar._reset()
    const { POST } = await import('@/app/api/auth/restore/route')
    // First restore consumes the nonce while still anonymous (204).
    expect((await POST(restoreReq(token))).status).toBe(204)
    cookieJar._reset()
    // Claim the account. The SAME (now-consumed) token would be a 409 *replay*
    // if the row were still anonymous — but because it is claimed, the claimed
    // branch must win (409 account_claimed) so the client is told to sign in
    // rather than "token already used". Proves the disambiguation branch order.
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb()
      .update(users)
      .set({
        email: 'owner2@example.com',
        passwordHash: 'argon2id$fake',
        claimedAt: 1781500000,
      })
      .where(eq(users.id, userId))
      .run()
    const res = await POST(restoreReq(token))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('account_claimed')
    expect(cookieJar.get('sl_uid')).toBeUndefined()
  })

  it('429s on the 11th attempt from the same IP within 5 min', async () => {
    const { POST } = await import('@/app/api/auth/restore/route')
    // 10 forged-token attempts pass the IP gate but get 401 at signature
    // check. 11th hits 429 on the rate limit.
    for (let i = 0; i < 10; i++) {
      const res = await POST(restoreReq('definitely-not-a-jwt'))
      expect(res.status).toBe(401)
    }
    const eleventh = await POST(restoreReq('definitely-not-a-jwt'))
    expect(eleventh.status).toBe(429)
    expect(eleventh.headers.get('Retry-After')).toBeTruthy()
  })

  it('400s on a malformed body', async () => {
    const { POST } = await import('@/app/api/auth/restore/route')
    const req = new Request('http://localhost:3000/api/auth/restore', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('403s on cross-origin POST', async () => {
    const { token } = await seedUserAndGetToken()
    const { POST } = await import('@/app/api/auth/restore/route')
    const res = await POST(
      restoreReq(token, {
        origin: 'http://evil.example.com',
        host: 'localhost:3000',
      }),
    )
    expect(res.status).toBe(403)
  })
})
