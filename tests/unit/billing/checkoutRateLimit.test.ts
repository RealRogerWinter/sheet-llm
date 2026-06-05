// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTesting, checkCheckoutRate, reapStaleCheckoutBuckets } from '@/lib/billing/checkoutRateLimit'

const ENV_KEYS = [
  'SL_CHECKOUT_USER_RATE_LIMIT',
  'SL_CHECKOUT_IP_RATE_LIMIT',
  'SL_CHECKOUT_RATE_MAX_ENTRIES',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  __resetForTesting()
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.useRealTimers()
})

describe('checkCheckoutRate', () => {
  it('allows attempts under the per-user limit and rejects the one over', () => {
    for (let i = 0; i < 10; i++) expect(checkCheckoutRate('u1', '1.1.1.1').ok).toBe(true)
    const over = checkCheckoutRate('u1', '1.1.1.1')
    expect(over.ok).toBe(false)
    expect(over.retryAfterSec).toBeGreaterThan(0)
  })

  it('enforces the per-IP limit across DIFFERENT users from one host', () => {
    // 20 distinct users sharing one IP — each is under its own limit, but the IP
    // budget (20) trips on the 21st: a multi-account-from-one-host signal.
    for (let i = 0; i < 20; i++) expect(checkCheckoutRate(`user-${i}`, '9.9.9.9').ok).toBe(true)
    expect(checkCheckoutRate('user-20', '9.9.9.9').ok).toBe(false)
  })

  it('honors the env override for the user limit', () => {
    process.env.SL_CHECKOUT_USER_RATE_LIMIT = '2'
    expect(checkCheckoutRate('u1', '2.2.2.2').ok).toBe(true)
    expect(checkCheckoutRate('u1', '2.2.2.2').ok).toBe(true)
    expect(checkCheckoutRate('u1', '2.2.2.2').ok).toBe(false)
  })

  it('a user-capped reject does NOT consume the IP budget (two-phase check)', () => {
    process.env.SL_CHECKOUT_USER_RATE_LIMIT = '1'
    process.env.SL_CHECKOUT_IP_RATE_LIMIT = '2'
    expect(checkCheckoutRate('u1', '3.3.3.3').ok).toBe(true) // ip hits = 1
    expect(checkCheckoutRate('u1', '3.3.3.3').ok).toBe(false) // user-capped; must not record an ip hit
    // If the reject had recorded an ip hit, ip would be 2 and this would reject.
    expect(checkCheckoutRate('u2', '3.3.3.3').ok).toBe(true) // ip hits = 2
  })

  it('an IP-capped reject does NOT consume the USER budget (two-phase, mirror)', () => {
    process.env.SL_CHECKOUT_IP_RATE_LIMIT = '1'
    process.env.SL_CHECKOUT_USER_RATE_LIMIT = '1'
    expect(checkCheckoutRate('uA', '5.5.5.5').ok).toBe(true) // ip 5.5.5.5 = 1, uA = 1
    expect(checkCheckoutRate('uB', '5.5.5.5').ok).toBe(false) // IP-capped; must not record a uB hit
    // If uB's user budget had been burned, this fresh-IP attempt would reject.
    expect(checkCheckoutRate('uB', '6.6.6.6').ok).toBe(true)
  })

  it('fails CLOSED for a new key once MAX_ENTRIES is reached', () => {
    process.env.SL_CHECKOUT_RATE_MAX_ENTRIES = '2' // room for exactly one (user,ip) pair
    expect(checkCheckoutRate('u1', '1.1.1.1').ok).toBe(true) // allocates u:u1 + ip:1.1.1.1 → store full
    expect(checkCheckoutRate('u2', '2.2.2.2').ok).toBe(false) // needs 2 new keys, none free → fail closed
    // The SAME pair reuses existing keys (no new allocation) → still served.
    expect(checkCheckoutRate('u1', '1.1.1.1').ok).toBe(true)
  })

  it('slides the window — budget refreshes after the window passes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-04T00:00:00Z'))
    process.env.SL_CHECKOUT_USER_RATE_LIMIT = '1'
    expect(checkCheckoutRate('u1', '4.4.4.4').ok).toBe(true)
    expect(checkCheckoutRate('u1', '4.4.4.4').ok).toBe(false)
    vi.setSystemTime(new Date('2026-06-04T01:00:01Z')) // > 1 hour later
    expect(checkCheckoutRate('u1', '4.4.4.4').ok).toBe(true)
  })
})

describe('reapStaleCheckoutBuckets (PR-13 periodic stale-key eviction)', () => {
  it('evicts a key whose every hit has aged out of the window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-04T00:00:00Z'))
    checkCheckoutRate('u1', '1.1.1.1') // creates u:u1 + ip:1.1.1.1
    expect(reapStaleCheckoutBuckets()).toBe(0) // both still in-window
    vi.setSystemTime(new Date('2026-06-04T01:00:01Z')) // > 1 hour → every hit expired
    expect(reapStaleCheckoutBuckets()).toBe(2) // both cold keys evicted
    expect(reapStaleCheckoutBuckets()).toBe(0) // store now empty
  })

  it('keeps a key with at least one in-window hit (trims the expired ones)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-04T00:00:00Z'))
    checkCheckoutRate('u1', '1.1.1.1') // hit at T0
    vi.setSystemTime(new Date('2026-06-04T00:30:00Z'))
    checkCheckoutRate('u1', '1.1.1.1') // hit at T+30m (under the default limit)
    vi.setSystemTime(new Date('2026-06-04T01:00:01Z')) // T0 expired, T+30m alive
    expect(reapStaleCheckoutBuckets()).toBe(0) // nothing fully cold
    // The bucket was trimmed to just the live hit, so budget is nearly fresh.
    expect(checkCheckoutRate('u1', '1.1.1.1').ok).toBe(true)
  })

  it('is a no-op when the store was never created (Stripe off / self-host)', () => {
    __resetForTesting() // store = undefined
    expect(reapStaleCheckoutBuckets()).toBe(0)
  })
})
