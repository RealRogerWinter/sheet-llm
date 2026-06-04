// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'

const now = () => Math.floor(Date.now() / 1000)

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
  const { __resetForTesting } = await import('@/lib/db/maybeReap')
  __resetForTesting()
})

async function seedUser(id = 'u1') {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb().insert(users).values({ id, createdAt: 0, lastSeenAt: 0 }).run()
}

describe('reapExpiredAuthTokens', () => {
  it('deletes consumed/expired tokens past retention, keeps live ones', async () => {
    await seedUser()
    const { getDb } = await import('@/lib/db')
    const { authTokens } = await import('@/lib/db/schema')
    const t = now()
    getDb()
      .insert(authTokens)
      .values([
        { id: 'live', userId: 'u1', purpose: 'email_verify', tokenHash: 'h-live', expiresAt: t + 1000, consumedAt: null, createdAt: t },
        { id: 'expired', userId: 'u1', purpose: 'email_verify', tokenHash: 'h-exp', expiresAt: 1, consumedAt: null, createdAt: 0 },
        { id: 'consumed', userId: 'u1', purpose: 'password_reset', tokenHash: 'h-con', expiresAt: t + 1000, consumedAt: 1, createdAt: 0 },
      ])
      .run()
    const { reapExpiredAuthTokens } = await import('@/lib/db/janitor')
    expect(reapExpiredAuthTokens().reaped).toBe(2)
    expect(getDb().select().from(authTokens).all().map((r) => r.id)).toEqual(['live'])
  })
})

describe('reapExpiredAuthSessions', () => {
  it('deletes revoked/expired sessions past retention, keeps live + recently-revoked', async () => {
    await seedUser()
    const { getDb } = await import('@/lib/db')
    const { authSessions } = await import('@/lib/db/schema')
    const t = now()
    getDb()
      .insert(authSessions)
      .values([
        { id: 'live', userId: 'u1', tokenHash: 'h-live', createdAt: t, expiresAt: t + 1000, idleExpiresAt: t + 1000, lastUsedAt: t },
        { id: 'expired', userId: 'u1', tokenHash: 'h-exp', createdAt: 0, expiresAt: 1, idleExpiresAt: 1, lastUsedAt: 0 },
        { id: 'old-revoked', userId: 'u1', tokenHash: 'h-rev', createdAt: 0, expiresAt: t + 1000, idleExpiresAt: t + 1000, lastUsedAt: 0, revokedAt: 1 },
        // Idle-dead but absolute-FUTURE and never revoked — a remember-me session
        // that went idle. Must still be reaped (matches verifyAuthSession liveness).
        { id: 'idle-dead', userId: 'u1', tokenHash: 'h-idle', createdAt: 0, expiresAt: t + 1000, idleExpiresAt: 1, lastUsedAt: 0 },
        { id: 'just-revoked', userId: 'u1', tokenHash: 'h-jr', createdAt: t, expiresAt: t + 1000, idleExpiresAt: t + 1000, lastUsedAt: t, revokedAt: t },
      ])
      .run()
    const { reapExpiredAuthSessions } = await import('@/lib/db/janitor')
    expect(reapExpiredAuthSessions().reaped).toBe(3) // expired + old-revoked + idle-dead
    expect(getDb().select().from(authSessions).all().map((r) => r.id).sort()).toEqual(['just-revoked', 'live'])
  })
})

describe('maybeReapAuth', () => {
  it('reaps dead auth rows via the throttled microtask', async () => {
    await seedUser()
    const { getDb } = await import('@/lib/db')
    const { authTokens } = await import('@/lib/db/schema')
    getDb()
      .insert(authTokens)
      .values({ id: 'expired', userId: 'u1', purpose: 'email_verify', tokenHash: 'h', expiresAt: 1, consumedAt: null, createdAt: 0 })
      .run()
    const { maybeReapAuth, __resetForTesting } = await import('@/lib/db/maybeReap')
    __resetForTesting()
    maybeReapAuth()
    await new Promise((r) => setTimeout(r, 0)) // flush the microtask
    expect(getDb().select().from(authTokens).all()).toHaveLength(0)
  })
})
