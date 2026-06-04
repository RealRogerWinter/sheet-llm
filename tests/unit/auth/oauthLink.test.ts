// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import type { OAuthUser } from '@/lib/auth/oauth/oauthUser'

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

async function seedUser(id: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb().insert(users).values({ id, createdAt: 0, lastSeenAt: 0, ...fields }).run()
  return id
}
async function seedOAuth(provider: string, providerAccountId: string, userId: string) {
  const { getDb } = await import('@/lib/db')
  const { oauthAccounts } = await import('@/lib/db/schema')
  getDb().insert(oauthAccounts).values({ id: `oa-${providerAccountId}`, userId, provider, providerAccountId, createdAt: 0 }).run()
}
function gUser(over: Partial<OAuthUser> = {}): OAuthUser {
  return { provider: 'google', providerAccountId: 'g-1', email: 'u@example.com', emailVerified: true, ...over }
}
async function oauthCount(): Promise<number> {
  const { getDb } = await import('@/lib/db')
  const { oauthAccounts } = await import('@/lib/db/schema')
  return getDb().select().from(oauthAccounts).all().length
}

describe('resolveOAuthLogin', () => {
  it('logs in an already-linked provider account', async () => {
    await seedUser('U', { email: 'u@example.com', emailVerified: 1, claimedAt: 1 })
    await seedOAuth('google', 'g-1', 'U')
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    expect(await resolveOAuthLogin(gUser(), { userId: 'anon', authenticated: false })).toEqual({
      ok: true,
      userId: 'U',
      kind: 'login',
    })
  })

  it('links the provider identity to the current account when already logged in', async () => {
    await seedUser('A', { email: 'a@example.com', emailVerified: 1, claimedAt: 1 })
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    const out = await resolveOAuthLogin(
      gUser({ providerAccountId: 'g-new', email: 'different@x.com' }),
      { userId: 'A', authenticated: true },
    )
    expect(out).toEqual({ ok: true, userId: 'A', kind: 'linked' })
    expect(await oauthCount()).toBe(1)
  })

  it('links a verified provider email to a VERIFIED local account (case-insensitive)', async () => {
    await seedUser('B', { email: 'b@example.com', emailVerified: 1, passwordHash: 'h', claimedAt: 1 })
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    expect(
      await resolveOAuthLogin(gUser({ providerAccountId: 'g-b', email: 'B@Example.com' }), { userId: 'anon', authenticated: false }),
    ).toEqual({ ok: true, userId: 'B', kind: 'linked' })
  })

  it('REFUSES to take over an UNVERIFIED local account (pre-hijacking defense)', async () => {
    await seedUser('C', { email: 'c@example.com', emailVerified: 0, passwordHash: 'planted', claimedAt: 1 })
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    expect(
      await resolveOAuthLogin(gUser({ providerAccountId: 'g-c', email: 'c@example.com' }), { userId: 'anon', authenticated: false }),
    ).toEqual({ ok: false, error: 'email_taken_unverified' })
    expect(await oauthCount()).toBe(0) // the planted account is untouched
  })

  it('refuses when the provider email is unverified', async () => {
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    expect(
      await resolveOAuthLogin(gUser({ emailVerified: false }), { userId: 'anon', authenticated: false }),
    ).toEqual({ ok: false, error: 'email_unverified' })
  })

  it('claims the current anon identity when no local account exists (atomic, normalized)', async () => {
    await seedUser('E') // pure anon: no email/password/claimedAt
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    expect(
      await resolveOAuthLogin(gUser({ providerAccountId: 'g-e', email: 'New@Example.com' }), { userId: 'E', authenticated: false }),
    ).toEqual({ ok: true, userId: 'E', kind: 'created' })
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const row = getDb().select().from(users).where(eq(users.id, 'E')).get()
    expect(row?.email).toBe('new@example.com') // normalized
    expect(row?.emailVerified).toBe(1)
    expect(row?.claimedAt).toBeTruthy() // claimed → restore refuses (account_claimed)
    expect(await oauthCount()).toBe(1)
  })

  it('returns claim_conflict if the anon identity was already claimed', async () => {
    await seedUser('F', { email: 'f@example.com', emailVerified: 1, claimedAt: 1 })
    const { resolveOAuthLogin } = await import('@/lib/auth/oauth/oauthLink')
    // The provider email has no local match → claim path → but F is already claimed.
    expect(
      await resolveOAuthLogin(gUser({ providerAccountId: 'g-f', email: 'brand-new@example.com' }), { userId: 'F', authenticated: false }),
    ).toEqual({ ok: false, error: 'claim_conflict' })
  })
})
