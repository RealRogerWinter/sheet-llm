// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../../factories/db'

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  vi.unstubAllEnvs()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

async function seedUser(id: string, tier: string, emailVerified: number) {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb()
    .insert(users)
    .values({
      id,
      createdAt: 0,
      lastSeenAt: 0,
      tier,
      emailVerified,
      ...(emailVerified ? { email: `${id}@example.com`, claimedAt: 1 } : {}),
    })
    .run()
}

async function resolve(userId?: string) {
  const { resolveGenerationTier } = await import('@/lib/orchestrator/generationTier')
  return resolveGenerationTier(userId)
}

describe('resolveGenerationTier — entitlements DB (SL_ENTITLEMENTS_DB)', () => {
  it('upgrades a VERIFIED pro user to pro', async () => {
    vi.stubEnv('SL_ENTITLEMENTS_DB', '1')
    vi.stubEnv('SL_GENERATION_TIER', '') // base = free
    await seedUser('pro-v', 'pro', 1)
    expect(await resolve('pro-v')).toBe('pro')
  })

  it('keeps a pro user with an UNVERIFIED email on free (pro requires verification)', async () => {
    vi.stubEnv('SL_ENTITLEMENTS_DB', '1')
    vi.stubEnv('SL_GENERATION_TIER', '')
    await seedUser('pro-u', 'pro', 0)
    expect(await resolve('pro-u')).toBe('free')
  })

  it('keeps a free-tier user on free', async () => {
    vi.stubEnv('SL_ENTITLEMENTS_DB', '1')
    vi.stubEnv('SL_GENERATION_TIER', '')
    await seedUser('free-u', 'free', 1)
    expect(await resolve('free-u')).toBe('free')
  })

  it('ignores the DB entirely when SL_ENTITLEMENTS_DB is off (env default applies)', async () => {
    vi.stubEnv('SL_ENTITLEMENTS_DB', '')
    vi.stubEnv('SL_GENERATION_TIER', '')
    await seedUser('pro-v', 'pro', 1)
    expect(await resolve('pro-v')).toBe('free') // entitlement ignored → env default free
  })

  it('an instance-wide pro default opens pro for everyone (no downgrade, no DB read)', async () => {
    vi.stubEnv('SL_ENTITLEMENTS_DB', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    await seedUser('free-u', 'free', 1)
    expect(await resolve('free-u')).toBe('pro') // base pro wins
  })

  it('force-free overrides the entitlement', async () => {
    vi.stubEnv('SL_FORCE_FREE_TIER', '1')
    vi.stubEnv('SL_ENTITLEMENTS_DB', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    await seedUser('pro-v', 'pro', 1)
    expect(await resolve('pro-v')).toBe('free')
  })

  it('falls back to the base when the user row is missing', async () => {
    vi.stubEnv('SL_ENTITLEMENTS_DB', '1')
    vi.stubEnv('SL_GENERATION_TIER', '')
    expect(await resolve('ghost')).toBe('free')
  })
})
