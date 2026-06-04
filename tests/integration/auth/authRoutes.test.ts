// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'

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
  const { __resetForTesting } = await import('@/lib/auth/authRateLimit')
  __resetForTesting()
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
function post(path: string, body: unknown, token: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'x-csrf-token': token,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/signup', () => {
  it('claims the anon identity (lowercased email + hash + claimed_at), sets sl_sess', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    const res = await POST(post('/api/auth/signup', { email: 'Me@Example.com', password: 'longenoughpw1' }, token))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.clearLocalStorage).toContain('sheet-llm:recovery')
    expect(cookieJar.get('sl_sess')).toBeDefined()
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const rows = getDb().select().from(users).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('me@example.com')
    expect(rows[0].passwordHash).toBeTruthy()
    expect(rows[0].claimedAt).toBeTruthy()
  })

  it('409 email_taken when the email already exists', async () => {
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb()
      .insert(users)
      .values({ id: 'u-existing', createdAt: 0, lastSeenAt: 0, email: 'taken@example.com', passwordHash: 'h', claimedAt: 1 })
      .run()
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    const res = await POST(post('/api/auth/signup', { email: 'TAKEN@example.com', password: 'longenoughpw1' }, token))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('email_taken')
  })

  it('400 on a weak password', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    const res = await POST(post('/api/auth/signup', { email: 'a@b.com', password: 'short' }, token))
    expect(res.status).toBe(400)
  })

  it('claims the CURRENT anon identity in place — same userId, pre-existing data carries over', async () => {
    // Establish an anonymous identity (mints sl_uid in the jar + a users row)
    // and attach a row owned by it.
    const { getRequestUser } = await import('@/lib/auth/session')
    const anon = await getRequestUser()
    const anonId = anon.userId
    expect(anon.authenticated).toBe(false)
    const { getDb } = await import('@/lib/db')
    const { authSessions, users } = await import('@/lib/db/schema')
    getDb()
      .insert(authSessions)
      .values({ id: 'pre-existing', userId: anonId, tokenHash: 'pre-hash', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 })
      .run()

    // Sign up — must CLAIM this row, not fork a second user.
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    const res = await POST(post('/api/auth/signup', { email: 'claimer@example.com', password: 'longenoughpw1' }, token))
    expect(res.status).toBe(200)

    const rows = getDb().select().from(users).all()
    expect(rows).toHaveLength(1) // claimed in place — NOT a new user row
    expect(rows[0].id).toBe(anonId)
    expect(rows[0].email).toBe('claimer@example.com')
    // The data attached before signup still belongs to the now-claimed account.
    const carried = getDb().select().from(authSessions).where(eq(authSessions.id, 'pre-existing')).get()
    expect(carried?.userId).toBe(anonId)
  })
})

describe('auth route front gate (guardAuthMutation)', () => {
  const creds = { email: 'a@b.com', password: 'longenoughpw1' }
  it('404 when SL_ACCOUNTS_ENABLED is off', async () => {
    vi.stubEnv('SL_ACCOUNTS_ENABLED', '')
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    expect((await POST(post('/api/auth/signup', creds, token))).status).toBe(404)
  })
  it('403 cross-origin', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    expect((await POST(post('/api/auth/signup', creds, token, { origin: 'http://evil.example' }))).status).toBe(403)
  })
  it('415 non-JSON', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    expect((await POST(post('/api/auth/signup', creds, token, { 'content-type': 'text/plain' }))).status).toBe(415)
  })
  it('403 on a missing / wrong CSRF token', async () => {
    await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    expect((await POST(post('/api/auth/signup', creds, 'wrong-token'))).status).toBe(403)
  })
})

async function seedAccount(email: string, password: string, extra: Record<string, unknown> = {}) {
  const { hashPassword } = await import('@/lib/auth/password')
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb()
    .insert(users)
    .values({
      id: 'acct-1',
      createdAt: 0,
      lastSeenAt: 0,
      email,
      passwordHash: await hashPassword(password),
      claimedAt: 1,
      ...extra,
    })
    .run()
}

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials → 200 + sl_sess (email case-insensitive)', async () => {
    await seedAccount('user@example.com', 'correct-password-1', { emailVerified: 1, tier: 'pro' })
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/login/route')
    const res = await POST(post('/api/auth/login', { email: 'User@Example.com', password: 'correct-password-1' }, token))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.tier).toBe('pro')
    expect(body.emailVerified).toBe(true)
    expect(cookieJar.get('sl_sess')).toBeDefined()
  })
  it('401 invalid_credentials on a wrong password', async () => {
    await seedAccount('user@example.com', 'correct-password-1')
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/login/route')
    const res = await POST(post('/api/auth/login', { email: 'user@example.com', password: 'wrong-password' }, token))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('invalid_credentials')
  })
  it('401 invalid_credentials on an unknown email (identical shape — no enumeration)', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/login/route')
    const res = await POST(post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever-123' }, token))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('invalid_credentials')
  })

  it('401 for an OAuth-only account (null password_hash) — identical shape, never a 500', async () => {
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb()
      .insert(users)
      .values({ id: 'oauth-1', createdAt: 0, lastSeenAt: 0, email: 'oauth@example.com', passwordHash: null, claimedAt: 1 })
      .run()
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/login/route')
    const res = await POST(post('/api/auth/login', { email: 'oauth@example.com', password: 'anything-here-1' }, token))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('invalid_credentials')
  })

  it('a CORRECT password is NEVER blocked by the per-email throttle (F1: no account-lockout DoS)', async () => {
    await seedAccount('victim@example.com', 'the-real-password-1')
    const { POST } = await import('@/app/api/auth/login/route')
    const fromAttacker = { 'x-forwarded-for': '203.0.113.7' }
    // Attacker sprays 8 wrong passwords for the victim's email → fills the
    // per-email FAILED-login window (each of the first 8 is a normal 401).
    for (let i = 0; i < 8; i++) {
      const t = await csrf()
      const res = await POST(post('/api/auth/login', { email: 'victim@example.com', password: `wrong-${i}-padding` }, t, fromAttacker))
      expect(res.status).toBe(401)
    }
    // A 9th FAILED attempt is now throttled — the brake works on failures.
    const tBad = await csrf()
    const blocked = await POST(post('/api/auth/login', { email: 'victim@example.com', password: 'still-wrong-pw' }, tBad, fromAttacker))
    expect(blocked.status).toBe(429)
    // …but the legitimate owner with the CORRECT password still logs in. The
    // email being "hot" must never lock the owner out (the whole point of F1).
    const tGood = await csrf()
    const ok = await POST(post('/api/auth/login', { email: 'victim@example.com', password: 'the-real-password-1' }, tGood, { 'x-forwarded-for': '198.51.100.23' }))
    expect(ok.status).toBe(200)
    expect((await ok.json()).ok).toBe(true)
    expect(cookieJar.get('sl_sess')).toBeDefined()
  })

  it('rememberMe:false mints an ephemeral (12h) cookie; the default is the long (90d) absolute', async () => {
    await seedAccount('rm@example.com', 'pw-1234567890')
    const { POST } = await import('@/app/api/auth/login/route')
    let t = await csrf()
    await POST(post('/api/auth/login', { email: 'rm@example.com', password: 'pw-1234567890', rememberMe: false }, t))
    const ephemeral = cookieJar.get('sl_sess')?.options as { maxAge?: number } | undefined
    expect(ephemeral?.maxAge).toBe(12 * 60 * 60)
    t = await csrf()
    await POST(post('/api/auth/login', { email: 'rm@example.com', password: 'pw-1234567890' }, t))
    const persistent = cookieJar.get('sl_sess')?.options as { maxAge?: number } | undefined
    expect(persistent?.maxAge).toBe(90 * 24 * 60 * 60)
  })
})

describe('logout / logout-all / session', () => {
  async function loginAccount() {
    await seedAccount('u@e.com', 'pw-1234567890')
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/login/route')
    await POST(post('/api/auth/login', { email: 'u@e.com', password: 'pw-1234567890' }, token))
  }

  it('session GET → authenticated after login, unauthenticated after logout', async () => {
    await loginAccount()
    const { GET } = await import('@/app/api/auth/session/route')
    let body = await (await GET()).json()
    expect(body.authenticated).toBe(true)
    expect(body.email).toBe('u@e.com')
    const { POST: logout } = await import('@/app/api/auth/logout/route')
    const lres = await logout(post('/api/auth/logout', {}, body.csrfToken))
    expect(lres.status).toBe(200)
    expect(cookieJar.get('sl_sess')).toBeUndefined()
    body = await (await GET()).json()
    expect(body.authenticated).toBe(false)
  })

  it('logout-all revokes every live session for the account', async () => {
    await loginAccount()
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    getDb()
      .insert(authSessions)
      .values({ id: 's2', userId: 'acct-1', tokenHash: 'h2', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 })
      .run()
    const { GET } = await import('@/app/api/auth/session/route')
    const sessBody = await (await GET()).json()
    const { POST: logoutAll } = await import('@/app/api/auth/logout-all/route')
    const res = await logoutAll(post('/api/auth/logout-all', {}, sessBody.csrfToken))
    expect(res.status).toBe(200)
    expect((await res.json()).revoked).toBe(2)
    const rows = getDb().select().from(authSessions).where(eq(authSessions.userId, 'acct-1')).all()
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true)
  })

  it('logout-all returns 401 when not authenticated (no sl_sess)', async () => {
    const token = await csrf()
    const { POST: logoutAll } = await import('@/app/api/auth/logout-all/route')
    const res = await logoutAll(post('/api/auth/logout-all', {}, token))
    expect(res.status).toBe(401)
  })

  it('session GET reports {enabled:false} when accounts are off, and still issues a CSRF token', async () => {
    vi.stubEnv('SL_ACCOUNTS_ENABLED', '')
    const { GET } = await import('@/app/api/auth/session/route')
    const body = await (await GET()).json()
    expect(body.enabled).toBe(false)
    expect(body.authenticated).toBe(false)
    expect(typeof body.csrfToken).toBe('string')
  })
})
