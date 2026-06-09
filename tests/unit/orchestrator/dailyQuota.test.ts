// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../../factories/db'
import type { QuotaInput } from '@/lib/orchestrator/dailyQuota'
import type { RiskVerdict } from '@/lib/security/ipRisk'

const CLEAR: RiskVerdict = { risky: false, reason: 'clear' }
const RISKY: RiskVerdict = { risky: true, reason: 'datacenter_asn', asn: 24940 }

function cfReq(ip: string): Request {
  return new Request('https://sheetllm.com/api/chat', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip, 'cf-ray': 'test-ray' },
  })
}
const input = (over: Partial<QuotaInput> & { ip?: string }): QuotaInput => ({
  user: over.user ?? { userId: 'anon', authenticated: false },
  tier: over.tier ?? 'free',
  request: over.request ?? cfReq(over.ip ?? '9.9.9.9'),
  risk: over.risk ?? CLEAR,
})

beforeEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
  vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '1')
  vi.stubEnv('SL_DAILY_QUOTA_ANON', '5')
  vi.stubEnv('SL_DAILY_QUOTA_FREE', '10')
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
  const { __resetQuotaStateForTesting } = await import('@/lib/orchestrator/dailyQuota')
  __resetQuotaStateForTesting()
})
afterEach(async () => {
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
  vi.unstubAllEnvs()
})

async function seedUser(id: string, emailVerified: 0 | 1, tier = 'free') {
  const { getDb } = await import('@/lib/db')
  const { users } = await import('@/lib/db/schema')
  getDb().insert(users).values({ id, createdAt: 0, lastSeenAt: 0, emailVerified, tier }).run()
}
async function keys(): Promise<string[]> {
  const { getDb } = await import('@/lib/db')
  const { requestQuota } = await import('@/lib/db/schema')
  return getDb()
    .select()
    .from(requestQuota)
    .all()
    .map((r) => r.quotaKey)
}

describe('checkDailyQuota', () => {
  it('is inert when the flag is off (returns ok, writes no rows)', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(checkDailyQuota(input({ ip: '1.1.1.1' })).ok).toBe(true)
    expect(await keys()).toHaveLength(0)
  })

  it('Pro bypasses entirely with no row written', async () => {
    await seedUser('p1', 1, 'pro')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    for (let i = 0; i < 30; i++) {
      expect(checkDailyQuota(input({ user: { userId: 'p1', authenticated: true }, tier: 'pro' })).ok).toBe(true)
    }
    expect(await keys()).toHaveLength(0)
  })

  it('anonymous clear IP: 5 ok, 6th is 429 quota_exceeded with a reset hint', async () => {
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const i = input({ ip: '9.9.9.9' })
    for (let n = 0; n < 5; n++) expect(checkDailyQuota(i).ok).toBe(true)
    const r = checkDailyQuota(i)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('quota_exceeded')
      expect(r.httpStatus).toBe(429)
      expect(r.quotaClass).toBe('anon')
      expect(r.resetsInHours).toBeGreaterThanOrEqual(1)
    }
    expect((await keys())[0]).toMatch(/^a:/)
  })

  it('verified logged-in free: 10 ok then 429, keyed on BOTH the device and account buckets', async () => {
    await seedUser('u1', 1, 'free')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const i = input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip: '9.9.9.9' })
    for (let n = 0; n < 10; n++) expect(checkDailyQuota(i).ok).toBe(true)
    expect(checkDailyQuota(i).ok).toBe(false)
    const k = await keys()
    expect(k).toContain('u:u1') // per-account bucket
    expect(k.some((x) => x.startsWith('a:'))).toBe(true) // per-device bucket too
  })

  it('anon 5 then verified login on the SAME device → only 5 more (10 TOTAL/device, not 15)', async () => {
    await seedUser('u1', 1, 'free')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const ip = '9.9.9.9'
    // 5 anonymous hits exhaust the anon sub-cap on the device bucket.
    let anonOk = 0
    for (let n = 0; n < 12; n++) {
      if (checkDailyQuota(input({ user: { userId: 'anon', authenticated: false }, tier: 'free', ip })).ok) anonOk++
      else break
    }
    expect(anonOk).toBe(5)
    // Logging in lifts the device bucket's limit to 10 — but the 5 anon hits
    // already counted, so exactly 5 more are granted (not a fresh 10).
    let loggedInOk = 0
    for (let n = 0; n < 12; n++) {
      if (checkDailyQuota(input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip })).ok) loggedInOk++
      else break
    }
    expect(loggedInOk).toBe(5)
    expect(anonOk + loggedInOk).toBe(10) // 10 max per device per day
  })

  it('account farming on ONE device is closed: a 2nd verified account gets 0 more', async () => {
    await seedUser('u1', 1, 'free')
    await seedUser('u2', 1, 'free')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const ip = '9.9.9.9'
    // First account burns the whole per-device budget.
    let a = 0
    for (let n = 0; n < 14; n++) {
      if (checkDailyQuota(input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip })).ok) a++
      else break
    }
    expect(a).toBe(10)
    // A freshly-created second account on the same device shares the device bucket
    // (now exhausted) → no extra generations, even though its own account bucket is empty.
    expect(checkDailyQuota(input({ user: { userId: 'u2', authenticated: true }, tier: 'free', ip })).ok).toBe(false)
    // All-or-nothing: the device-bucket deny must NOT have created/incremented u2's
    // own account row (a reject on one bucket never burns a slot on another).
    expect(await keys()).not.toContain('u:u2')
  })

  it('all-or-nothing the OTHER way: account-cap deny does not burn the device bucket', async () => {
    await seedUser('u1', 1, 'free')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const { getDb } = await import('@/lib/db')
    const { requestQuota } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    // u1 exhausts the per-ACCOUNT bucket from device A.
    for (let n = 0; n < 10; n++) expect(checkDailyQuota(input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip: '1.1.1.1' })).ok).toBe(true)
    // Move to a FRESH device B: the account bucket (u:u1=10) denies before the
    // brand-new device bucket is ever written — so device B's 'a:' row must not exist.
    expect(checkDailyQuota(input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip: '2.2.2.2' })).ok).toBe(false)
    const account = getDb().select().from(requestQuota).where(eq(requestQuota.quotaKey, 'u:u1')).get()
    expect(account?.count).toBe(10) // not 11 — the account row wasn't over-incremented either
    // Only device A's 'a:' row exists; device B's was never inserted by the denied request.
    const deviceRows = (await keys()).filter((k) => k.startsWith('a:'))
    expect(deviceRows).toHaveLength(1)
  })

  it('per-account cap follows the user across devices (roaming IPs): 10 total, not 10 per IP', async () => {
    await seedUser('u1', 1, 'free')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    // Device A: 6 hits.
    let a = 0
    for (let n = 0; n < 6; n++) if (checkDailyQuota(input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip: '1.1.1.1' })).ok) a++
    expect(a).toBe(6)
    // Device B (different IP, fresh device bucket): the account bucket carries 6,
    // so only 4 more before the per-account cap of 10 bites.
    let b = 0
    for (let n = 0; n < 8; n++) if (checkDailyQuota(input({ user: { userId: 'u1', authenticated: true }, tier: 'free', ip: '2.2.2.2' })).ok) b++
    expect(b).toBe(4)
    expect(a + b).toBe(10)
  })

  it('unverified logged-in is demoted to the anon tier (5, keyed on IP — defeats account-farming)', async () => {
    await seedUser('u2', 0, 'free')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const i = input({ user: { userId: 'u2', authenticated: true }, tier: 'free', ip: '8.8.8.8' })
    for (let n = 0; n < 5; n++) expect(checkDailyQuota(i).ok).toBe(true)
    expect(checkDailyQuota(i).ok).toBe(false)
    const k = await keys()
    expect(k.some((x) => x.startsWith('a:'))).toBe(true)
    expect(k).not.toContain('u:u2')
  })

  it('anon device cap: IP rotation with the SAME sl_uid is STILL blocked once the device bucket is exhausted', async () => {
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    // Same anonymous identity (stable sl_uid 'dev1') but a wifi<->cellular switch
    // changes the IP /24 on every call — the per-IP 'a:' bucket never bites.
    const me = { userId: 'dev1', authenticated: false }
    let ok = 0
    for (let n = 0; n < 12; n++) {
      const i = input({ user: me, tier: 'free', ip: `10.0.${n}.5` })
      if (checkDailyQuota(i).ok) ok++
      else break
    }
    // Bound by the anon limit on the per-DEVICE bucket, not refreshed per network.
    expect(ok).toBe(5)
    const k = await keys()
    expect(k).toContain('d:dev1') // per-device (sl_uid) bucket exists
    expect(k.filter((x) => x.startsWith('a:')).length).toBe(5) // a fresh IP floor per network
  })

  it('clearing/changing the sl_uid cookie (new userId) on the SAME IP is still bounded by the IP a: floor', async () => {
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const ip = '11.11.11.11'
    // Each request presents a brand-new sl_uid (as if the cookie were cleared) but
    // shares one IP /24. The device 'd:' bucket is always fresh, so only the IP
    // 'a:' floor can bound this — it must, capping the IP at the anon limit.
    let ok = 0
    for (let n = 0; n < 12; n++) {
      const i = input({ user: { userId: `wiped-${n}`, authenticated: false }, tier: 'free', ip })
      if (checkDailyQuota(i).ok) ok++
      else break
    }
    expect(ok).toBe(5) // the IP floor holds even as the device key churns
    const k = await keys()
    expect(k.filter((x) => x.startsWith('a:')).length).toBe(1) // one shared IP bucket
  })

  it('anon device bucket uses the anon limit + 24h window; admission decrements BOTH buckets; no refund', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ANON', '3')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const { getDb } = await import('@/lib/db')
    const { requestQuota } = await import('@/lib/db/schema')
    const { eq, sql } = await import('drizzle-orm')
    const me = { userId: 'dev2', authenticated: false }
    const ip = '12.12.12.12'
    // Two admissions on one device+IP increment BOTH buckets in lockstep.
    expect(checkDailyQuota(input({ user: me, tier: 'free', ip })).ok).toBe(true)
    expect(checkDailyQuota(input({ user: me, tier: 'free', ip })).ok).toBe(true)
    const dev = getDb().select().from(requestQuota).where(eq(requestQuota.quotaKey, 'd:dev2')).get()
    const ipRow = getDb().select().from(requestQuota).all().find((r) => r.quotaKey.startsWith('a:'))
    expect(dev?.count).toBe(2)
    expect(ipRow?.count).toBe(2)
    expect(dev?.userId).toBeNull() // null like 'a:' so the time-based janitor reaps it
    // The device bucket honours the anon limit (3) — a 4th from a NEW IP is denied
    // by 'd:' (the IP floor is fresh), and the denial must NOT refund either bucket.
    expect(checkDailyQuota(input({ user: me, tier: 'free', ip })).ok).toBe(true) // 3rd ok
    const r = checkDailyQuota(input({ user: me, tier: 'free', ip: '99.99.99.99' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.quotaClass).toBe('anon')
    const devAfter = getDb().select().from(requestQuota).where(eq(requestQuota.quotaKey, 'd:dev2')).get()
    expect(devAfter?.count).toBe(3) // not 4, not refunded to 2
    // The fresh IP's 'a:' row was never written by the denied request (all-or-nothing).
    expect((await keys()).filter((x) => x.startsWith('a:')).length).toBe(1)
    // The 24h window: rewinding window_start fully lets the device bucket reset.
    getDb().run(sql`UPDATE request_quota SET window_start = window_start - 100000`)
    expect(checkDailyQuota(input({ user: me, tier: 'free', ip })).ok).toBe(true)
  })

  it('risky anon + accounts ON → login_required 403, no row', async () => {
    vi.stubEnv('SL_ACCOUNTS_ENABLED', '1')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const r = checkDailyQuota(input({ risk: RISKY, ip: '5.5.5.5' }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('login_required')
      expect(r.httpStatus).toBe(403)
      expect(r.needsSignIn).toBe(true)
    }
    expect(await keys()).toHaveLength(0)
  })

  it('risky anon + accounts OFF → falls back to the anon limit (never login_required)', async () => {
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(checkDailyQuota(input({ risk: RISKY, ip: '6.6.6.6' })).ok).toBe(true)
  })

  it('resets the window once it has fully closed', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ANON', '2')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const i = input({ ip: '7.7.7.7' })
    expect(checkDailyQuota(i).ok).toBe(true)
    expect(checkDailyQuota(i).ok).toBe(true)
    expect(checkDailyQuota(i).ok).toBe(false)
    const { getDb } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    getDb().run(sql`UPDATE request_quota SET window_start = window_start - 100000`)
    expect(checkDailyQuota(i).ok).toBe(true) // window expired → reset to count 1
  })

  it('never exceeds the limit even across many rapid calls (guard-in-the-write)', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ANON', '5')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const i = input({ ip: '4.4.4.4' })
    const oks = Array.from({ length: 25 }, () => checkDailyQuota(i)).filter((r) => r.ok).length
    expect(oks).toBe(5)
    const { getDb } = await import('@/lib/db')
    const { requestQuota } = await import('@/lib/db/schema')
    expect(getDb().select().from(requestQuota).all()[0].count).toBe(5)
  })

  it('admission cap fails OPEN: new keys past the cap are admitted WITHOUT a row', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_MAX_ROWS', '1')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(checkDailyQuota(input({ ip: '1.1.1.1' })).ok).toBe(true)
    expect(await keys()).toHaveLength(1)
    // distinct IP → new key, but the table is at the cap → admit, don't insert
    expect(checkDailyQuota(input({ ip: '2.2.2.2' })).ok).toBe(true)
    expect(await keys()).toHaveLength(1)
  })

  it('enforces the optional instance-wide anon ceiling', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ANON_GLOBAL', '2')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(checkDailyQuota(input({ ip: '1.1.1.1' })).ok).toBe(true)
    expect(checkDailyQuota(input({ ip: '2.2.2.2' })).ok).toBe(true)
    const r = checkDailyQuota(input({ ip: '3.3.3.3' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.quotaClass).toBe('global')
  })

  it('bypasses (no row) when the IP is untrusted / not a CF request', async () => {
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const noCdn = new Request('https://sheetllm.com/api/chat', { method: 'POST' }) // no cf-* headers
    expect(checkDailyQuota(input({ request: noCdn })).ok).toBe(true)
    expect(await keys()).toHaveLength(0)
  })

  it('FAILS OPEN (returns ok) when the quota store is unavailable', async () => {
    const { getDb } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    getDb().run(sql`DROP TABLE request_quota`) // every quota query now throws
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(checkDailyQuota(input({ ip: '9.9.9.9' })).ok).toBe(true)
  })

  it('commits BOTH the instance-ceiling row and the per-key row on a passing request', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ANON_GLOBAL', '5')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    expect(checkDailyQuota(input({ ip: '9.9.9.9' })).ok).toBe(true)
    const k = await keys()
    expect(k).toContain('*')
    expect(k.some((x) => x.startsWith('a:'))).toBe(true)
  })

  it('reports ~24h (not 25) for a fresh full-window denial', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ANON', '1')
    const { checkDailyQuota } = await import('@/lib/orchestrator/dailyQuota')
    const i = input({ ip: '9.9.9.9' })
    expect(checkDailyQuota(i).ok).toBe(true)
    const r = checkDailyQuota(i)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.resetsInHours).toBe(24)
  })
})

describe('normalizeQuotaIp', () => {
  it('truncates v4→/24, v6→/56, and returns null for local', async () => {
    const { normalizeQuotaIp } = await import('@/lib/orchestrator/dailyQuota')
    expect(normalizeQuotaIp('1.2.3.4')).toBe('1.2.3.0/24')
    expect(normalizeQuotaIp('local')).toBeNull()
    expect(normalizeQuotaIp('2001:db8::1')).toBe(normalizeQuotaIp('2001:db8::1234'))
  })
})
