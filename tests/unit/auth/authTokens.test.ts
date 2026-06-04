// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { makeTestDb } from '../../factories/db'

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

async function seedUser(id = 'u1'): Promise<string> {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb().insert(users).values({ id, createdAt: 0, lastSeenAt: 0 }).run()
  return id
}

describe('authTokens', () => {
  it('mints a raw token and consumes it exactly once (single-use CAS)', async () => {
    const userId = await seedUser()
    const { createAuthToken, consumeAuthToken } = await import('@/lib/auth/authTokens')
    const token = await createAuthToken(userId, 'email_verify')
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(20)
    expect((await consumeAuthToken(token, 'email_verify'))?.userId).toBe(userId)
    expect(await consumeAuthToken(token, 'email_verify')).toBeNull() // already used
  })

  it('rejects a wrong purpose (and the right purpose still works)', async () => {
    const userId = await seedUser()
    const { createAuthToken, consumeAuthToken } = await import('@/lib/auth/authTokens')
    const token = await createAuthToken(userId, 'password_reset')
    expect(await consumeAuthToken(token, 'email_verify')).toBeNull()
    expect((await consumeAuthToken(token, 'password_reset'))?.userId).toBe(userId)
  })

  it('rejects an unknown token', async () => {
    await seedUser()
    const { consumeAuthToken } = await import('@/lib/auth/authTokens')
    expect(await consumeAuthToken('totally-unknown-token-value-123', 'email_verify')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const userId = await seedUser()
    const { getDb } = await import('@/lib/db')
    const { authTokens } = await import('@/lib/db/schema')
    const raw = 'expired-token-raw-value-1234567890'
    getDb()
      .insert(authTokens)
      .values({
        id: 't-exp',
        userId,
        purpose: 'email_verify',
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: 1, // epoch second 1 → long past
        consumedAt: null,
        createdAt: 0,
      })
      .run()
    const { consumeAuthToken } = await import('@/lib/auth/authTokens')
    expect(await consumeAuthToken(raw, 'email_verify')).toBeNull()
  })

  it('invalidateUserTokens kills outstanding tokens of one purpose only', async () => {
    const userId = await seedUser()
    const { createAuthToken, consumeAuthToken, invalidateUserTokens } = await import(
      '@/lib/auth/authTokens'
    )
    const verify = await createAuthToken(userId, 'email_verify')
    const reset = await createAuthToken(userId, 'password_reset')
    await invalidateUserTokens(userId, 'email_verify')
    expect(await consumeAuthToken(verify, 'email_verify')).toBeNull() // invalidated
    expect((await consumeAuthToken(reset, 'password_reset'))?.userId).toBe(userId) // untouched
  })
})
