// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'

type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (n: string) => map.get(n),
    set: (n: string, v: string, o?: unknown) => map.set(n, { name: n, value: v, options: o }),
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
  const { __resetEmailRateForTesting } = await import('@/lib/auth/emailRateLimit')
  __resetEmailRateForTesting()
  const { setEmailProviderForTesting } = await import('@/lib/auth/email')
  setEmailProviderForTesting({ name: 'capture', async send() {} })
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
function post(path: string, body: unknown, token: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'x-csrf-token': token,
    },
    body: JSON.stringify(body),
  })
}
async function seedAccount(email: string, password: string, extra: Record<string, unknown> = {}) {
  const { hashPassword } = await import('@/lib/auth/password')
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb()
    .insert(users)
    .values({ id: 'acct-1', createdAt: 0, lastSeenAt: 0, email, passwordHash: await hashPassword(password), claimedAt: 1, ...extra })
    .run()
}
async function loginAccount(email: string, password: string) {
  const { POST } = await import('@/app/api/auth/login/route')
  await POST(post('/api/auth/login', { email, password }, await csrf()))
}
async function sessionCsrf(): Promise<string> {
  const { GET } = await import('@/app/api/auth/session/route')
  return (await (await GET()).json()).csrfToken
}
async function liveSessions(userId: string) {
  const { getDb } = await import('@/lib/db')
  const { authSessions } = await import('@/lib/db/schema')
  return getDb()
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .all()
}

describe('POST /api/auth/change-password', () => {
  it('verifies the current password, rotates the session, revokes others', async () => {
    await seedAccount('u@e.com', 'old-password-12', { emailVerified: 1 })
    await loginAccount('u@e.com', 'old-password-12')
    const { getDb } = await import('@/lib/db')
    const { authSessions, users } = await import('@/lib/db/schema')
    getDb()
      .insert(authSessions)
      .values({ id: 'other', userId: 'acct-1', tokenHash: 'other-hash', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 })
      .run()
    const oldHash = getDb().select().from(users).where(eq(users.id, 'acct-1')).get()?.passwordHash

    const { POST } = await import('@/app/api/auth/change-password/route')
    const res = await POST(post('/api/auth/change-password', { currentPassword: 'old-password-12', newPassword: 'brand-new-pass-1' }, await sessionCsrf()))
    expect(res.status).toBe(200)
    expect(getDb().select().from(users).where(eq(users.id, 'acct-1')).get()?.passwordHash).not.toBe(oldHash)
    expect(getDb().select().from(authSessions).where(eq(authSessions.id, 'other')).get()?.revokedAt).not.toBeNull()
    expect(await liveSessions('acct-1')).toHaveLength(1) // only the rotated current
  })

  it('401 on a wrong current password (password unchanged)', async () => {
    await seedAccount('u@e.com', 'old-password-12')
    await loginAccount('u@e.com', 'old-password-12')
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const before = getDb().select().from(users).where(eq(users.id, 'acct-1')).get()?.passwordHash
    const { POST } = await import('@/app/api/auth/change-password/route')
    const res = await POST(post('/api/auth/change-password', { currentPassword: 'WRONG', newPassword: 'brand-new-pass-1' }, await sessionCsrf()))
    expect(res.status).toBe(401)
    expect(getDb().select().from(users).where(eq(users.id, 'acct-1')).get()?.passwordHash).toBe(before)
  })

  it('401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/auth/change-password/route')
    const res = await POST(post('/api/auth/change-password', { currentPassword: 'x', newPassword: 'brand-new-pass-1' }, await csrf()))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/auth/change-email', () => {
  it('changes the email (normalized) and marks it unverified', async () => {
    await seedAccount('old@e.com', 'pw-1234567890', { emailVerified: 1 })
    await loginAccount('old@e.com', 'pw-1234567890')
    const { POST } = await import('@/app/api/auth/change-email/route')
    const res = await POST(post('/api/auth/change-email', { newEmail: 'New@Example.com', currentPassword: 'pw-1234567890' }, await sessionCsrf()))
    expect(res.status).toBe(200)
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const row = getDb().select().from(users).where(eq(users.id, 'acct-1')).get()
    expect(row?.email).toBe('new@example.com')
    expect(row?.emailVerified).toBe(0)
  })

  it('409 when the new email is already taken', async () => {
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    getDb().insert(users).values({ id: 'other-acct', createdAt: 0, lastSeenAt: 0, email: 'taken@example.com', passwordHash: 'h', claimedAt: 1 }).run()
    await seedAccount('mine@e.com', 'pw-1234567890', { emailVerified: 1 })
    await loginAccount('mine@e.com', 'pw-1234567890')
    const { POST } = await import('@/app/api/auth/change-email/route')
    const res = await POST(post('/api/auth/change-email', { newEmail: 'taken@example.com', currentPassword: 'pw-1234567890' }, await sessionCsrf()))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('email_taken')
  })

  it('401 on a wrong current password', async () => {
    await seedAccount('u@e.com', 'pw-1234567890', { emailVerified: 1 })
    await loginAccount('u@e.com', 'pw-1234567890')
    const { POST } = await import('@/app/api/auth/change-email/route')
    const res = await POST(post('/api/auth/change-email', { newEmail: 'new@example.com', currentPassword: 'WRONG' }, await sessionCsrf()))
    expect(res.status).toBe(401)
  })
})

describe('GET /api/auth/sessions', () => {
  it('lists live sessions with exactly one flagged current', async () => {
    await seedAccount('u@e.com', 'pw-1234567890')
    await loginAccount('u@e.com', 'pw-1234567890')
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    getDb()
      .insert(authSessions)
      .values({ id: 'other', userId: 'acct-1', tokenHash: 'other-hash', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 })
      .run()
    const { GET } = await import('@/app/api/auth/sessions/route')
    const body = await (await GET()).json()
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
  })

  it('401 when unauthenticated', async () => {
    const { GET } = await import('@/app/api/auth/sessions/route')
    expect((await GET()).status).toBe(401)
  })
})

describe('POST /api/auth/sessions/revoke', () => {
  it('revokes the user\'s own session but never another user\'s', async () => {
    await seedAccount('u@e.com', 'pw-1234567890')
    await loginAccount('u@e.com', 'pw-1234567890')
    const { getDb } = await import('@/lib/db')
    const { authSessions, users } = await import('@/lib/db/schema')
    getDb().insert(authSessions).values({ id: 'mine', userId: 'acct-1', tokenHash: 'mine-hash', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 }).run()
    getDb().insert(users).values({ id: 'victim', createdAt: 0, lastSeenAt: 0 }).run()
    getDb().insert(authSessions).values({ id: 'victim-sess', userId: 'victim', tokenHash: 'victim-hash', createdAt: 1, expiresAt: 9_999_999_999, idleExpiresAt: 9_999_999_999, lastUsedAt: 1 }).run()

    const { POST } = await import('@/app/api/auth/sessions/revoke/route')
    const r1 = await POST(post('/api/auth/sessions/revoke', { id: 'mine' }, await sessionCsrf()))
    expect((await r1.json()).revoked).toBe(true)
    expect(getDb().select().from(authSessions).where(eq(authSessions.id, 'mine')).get()?.revokedAt).not.toBeNull()

    const r2 = await POST(post('/api/auth/sessions/revoke', { id: 'victim-sess' }, await sessionCsrf()))
    expect((await r2.json()).revoked).toBe(false) // not ours → no-op
    expect(getDb().select().from(authSessions).where(eq(authSessions.id, 'victim-sess')).get()?.revokedAt).toBeNull()
  })

  it('401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/auth/sessions/revoke/route')
    expect((await POST(post('/api/auth/sessions/revoke', { id: 'x' }, await csrf()))).status).toBe(401)
  })
})
