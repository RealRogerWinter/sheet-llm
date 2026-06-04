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

const captured: Array<{ to: string; subject: string; text: string }> = []

beforeEach(async () => {
  cookieJar._reset()
  captured.length = 0
  vi.stubEnv('SESSION_SECRET', 'test-secret-please-do-not-use-in-production-32+bytes')
  vi.stubEnv('RECOVERY_SECRET', 'recovery-test-secret-distinct-from-session-32+bytes-x')
  vi.stubEnv('SL_ACCOUNTS_ENABLED', '1')
  vi.resetModules()
  const { __resetForTesting } = await import('@/lib/auth/authRateLimit')
  __resetForTesting()
  const { __resetEmailRateForTesting } = await import('@/lib/auth/emailRateLimit')
  __resetEmailRateForTesting()
  const { setEmailProviderForTesting } = await import('@/lib/auth/email')
  setEmailProviderForTesting({
    name: 'capture',
    async send(m) {
      captured.push(m)
    },
  })
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  vi.unstubAllEnvs()
  const { setEmailProviderForTesting } = await import('@/lib/auth/email')
  setEmailProviderForTesting(undefined)
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
function tokenFromLink(text: string): string {
  const m = text.match(/[?&]token=([A-Za-z0-9_-]+)/)
  if (!m) throw new Error('no token in email body: ' + text)
  return m[1]
}
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
async function freshCsrfAfterLogin(): Promise<string> {
  const { GET } = await import('@/app/api/auth/session/route')
  return (await (await GET()).json()).csrfToken
}

describe('signup → verification email', () => {
  it('signup sends a verification email containing a /verify-email?token= link', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    const res = await POST(post('/api/auth/signup', { email: 'new@example.com', password: 'longenoughpw1' }, token))
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(captured.length).toBe(1))
    expect(captured[0].to).toBe('new@example.com')
    expect(captured[0].text).toContain('/verify-email?token=')
  })

  it('rejects a disposable email at signup (400) and sends nothing', async () => {
    const token = await csrf()
    const { POST } = await import('@/app/api/auth/signup/route')
    const res = await POST(post('/api/auth/signup', { email: 'x@mailinator.com', password: 'longenoughpw1' }, token))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('disposable_email')
    expect(captured.length).toBe(0)
  })

  it('end-to-end: signup → open the emailed verify link → emailVerified=1', async () => {
    const token = await csrf()
    const { POST: signup } = await import('@/app/api/auth/signup/route')
    await signup(post('/api/auth/signup', { email: 'e2e@example.com', password: 'longenoughpw1' }, token))
    await vi.waitFor(() => expect(captured.length).toBe(1))
    const verifyToken = tokenFromLink(captured[0].text)
    const csrfTok = await csrf()
    const { POST: verify } = await import('@/app/api/auth/verify-email/route')
    const res = await verify(post('/api/auth/verify-email', { token: verifyToken }, csrfTok))
    expect(res.status).toBe(200)
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const row = getDb().select().from(users).where(eq(users.email, 'e2e@example.com')).get()
    expect(row?.emailVerified).toBe(1)
  })
})

describe('POST /api/auth/verify-email', () => {
  it('consumes a valid token → emailVerified=1; replay → 400', async () => {
    await seedAccount('v@example.com', 'pw-1234567890', { emailVerified: 0 })
    const { createAuthToken } = await import('@/lib/auth/authTokens')
    const vtoken = await createAuthToken('acct-1', 'email_verify')
    const { POST } = await import('@/app/api/auth/verify-email/route')
    const res = await POST(post('/api/auth/verify-email', { token: vtoken }, await csrf()))
    expect(res.status).toBe(200)
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    expect(getDb().select().from(users).where(eq(users.id, 'acct-1')).get()?.emailVerified).toBe(1)
    const replay = await POST(post('/api/auth/verify-email', { token: vtoken }, await csrf()))
    expect(replay.status).toBe(400)
    expect((await replay.json()).code).toBe('invalid_token')
  })
})

describe('POST /api/auth/forgot (no enumeration)', () => {
  it('always 200; mints a reset token + sends a /reset?token= email for an existing password account', async () => {
    await seedAccount('exists@example.com', 'pw-1234567890')
    const { POST } = await import('@/app/api/auth/forgot/route')
    const res = await POST(post('/api/auth/forgot', { email: 'Exists@Example.com' }, await csrf()))
    expect(res.status).toBe(200)
    const { getDb } = await import('@/lib/db')
    const { authTokens } = await import('@/lib/db/schema')
    const rows = getDb().select().from(authTokens).where(eq(authTokens.userId, 'acct-1')).all()
    expect(rows.filter((r) => r.purpose === 'password_reset' && r.consumedAt === null)).toHaveLength(1)
    await vi.waitFor(() => expect(captured.length).toBe(1))
    expect(captured[0].text).toContain('/reset?token=')
  })

  it('returns 200 but mints no token and sends nothing for an unknown email', async () => {
    const { POST } = await import('@/app/api/auth/forgot/route')
    const res = await POST(post('/api/auth/forgot', { email: 'nobody@example.com' }, await csrf()))
    expect(res.status).toBe(200)
    const { getDb } = await import('@/lib/db')
    const { authTokens } = await import('@/lib/db/schema')
    expect(getDb().select().from(authTokens).all()).toHaveLength(0)
    expect(captured.length).toBe(0)
  })

  it('returns 200 but does NOT mint a token for an OAuth-only account (no password)', async () => {
    const { getDb } = await import('@/lib/db')
    const { users, authTokens } = await import('@/lib/db/schema')
    getDb()
      .insert(users)
      .values({ id: 'oauth-1', createdAt: 0, lastSeenAt: 0, email: 'oauth@example.com', passwordHash: null, claimedAt: 1 })
      .run()
    const { POST } = await import('@/app/api/auth/forgot/route')
    const res = await POST(post('/api/auth/forgot', { email: 'oauth@example.com' }, await csrf()))
    expect(res.status).toBe(200)
    expect(getDb().select().from(authTokens).all()).toHaveLength(0)
  })
})

describe('POST /api/auth/reset', () => {
  it('sets a new password, marks verified, revokes all sessions; replay → 400', async () => {
    await seedAccount('r@example.com', 'old-password-12', { emailVerified: 0 })
    const { getDb } = await import('@/lib/db')
    const { authSessions, users } = await import('@/lib/db/schema')
    getDb()
      .insert(authSessions)
      .values({ id: 's-live', userId: 'acct-1', tokenHash: 'h-live', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 })
      .run()
    const { createAuthToken } = await import('@/lib/auth/authTokens')
    const rtoken = await createAuthToken('acct-1', 'password_reset')
    const oldHash = getDb().select().from(users).where(eq(users.id, 'acct-1')).get()?.passwordHash

    const { POST } = await import('@/app/api/auth/reset/route')
    const res = await POST(post('/api/auth/reset', { token: rtoken, password: 'brand-new-password-1' }, await csrf()))
    expect(res.status).toBe(200)
    const row = getDb().select().from(users).where(eq(users.id, 'acct-1')).get()
    expect(row?.passwordHash).not.toBe(oldHash)
    expect(row?.emailVerified).toBe(1) // reset proves inbox control
    expect(getDb().select().from(authSessions).where(eq(authSessions.id, 's-live')).get()?.revokedAt).not.toBeNull()

    const replay = await POST(post('/api/auth/reset', { token: rtoken, password: 'another-pw-123' }, await csrf()))
    expect(replay.status).toBe(400)
  })

  it('400 on an unknown/invalid token', async () => {
    const { POST } = await import('@/app/api/auth/reset/route')
    const res = await POST(post('/api/auth/reset', { token: 'not-a-real-token-1234567890', password: 'whatever-pw-1' }, await csrf()))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_token')
  })
})

describe('POST /api/auth/verify-email/send', () => {
  it('401 when not authenticated', async () => {
    const { POST } = await import('@/app/api/auth/verify-email/send/route')
    const res = await POST(post('/api/auth/verify-email/send', {}, await csrf()))
    expect(res.status).toBe(401)
  })

  it('authenticated + unverified → sends a verification email', async () => {
    await seedAccount('u@e.com', 'pw-1234567890', { emailVerified: 0 })
    const { POST: login } = await import('@/app/api/auth/login/route')
    await login(post('/api/auth/login', { email: 'u@e.com', password: 'pw-1234567890' }, await csrf()))
    captured.length = 0
    const { POST } = await import('@/app/api/auth/verify-email/send/route')
    const res = await POST(post('/api/auth/verify-email/send', {}, await freshCsrfAfterLogin()))
    expect(res.status).toBe(200)
    expect(captured.length).toBe(1)
    expect(captured[0].to).toBe('u@e.com')
    expect(captured[0].text).toContain('/verify-email?token=')
  })

  it('authenticated + already verified → 200 alreadyVerified, no send', async () => {
    await seedAccount('u@e.com', 'pw-1234567890', { emailVerified: 1 })
    const { POST: login } = await import('@/app/api/auth/login/route')
    await login(post('/api/auth/login', { email: 'u@e.com', password: 'pw-1234567890' }, await csrf()))
    captured.length = 0
    const { POST } = await import('@/app/api/auth/verify-email/send/route')
    const res = await POST(post('/api/auth/verify-email/send', {}, await freshCsrfAfterLogin()))
    expect(res.status).toBe(200)
    expect((await res.json()).alreadyVerified).toBe(true)
    expect(captured.length).toBe(0)
  })
})
