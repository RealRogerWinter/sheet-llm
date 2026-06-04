// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(async () => {
  const { __resetForTesting } = await import('@/lib/auth/authRateLimit')
  __resetForTesting()
})
afterEach(() => vi.unstubAllEnvs())

describe('authRateLimit', () => {
  it('per-IP allows up to the limit then 429s; other IPs unaffected', async () => {
    const { checkAuthIp } = await import('@/lib/auth/authRateLimit')
    for (let i = 0; i < 20; i++) expect(checkAuthIp('1.2.3.4').ok).toBe(true)
    const over = checkAuthIp('1.2.3.4')
    expect(over.ok).toBe(false)
    expect(over.retryAfterSec).toBeGreaterThan(0)
    expect(checkAuthIp('5.6.7.8').ok).toBe(true)
  })

  it('per-email throttle blocks only after recorded FAILURES (check never records)', async () => {
    const { checkEmailThrottle, recordEmailFailure } = await import('@/lib/auth/authRateLimit')
    // Checking 50× never blocks — only failures count.
    for (let i = 0; i < 50; i++) expect(checkEmailThrottle('a@b.c').ok).toBe(true)
    for (let i = 0; i < 8; i++) recordEmailFailure('a@b.c')
    expect(checkEmailThrottle('a@b.c').ok).toBe(false)
    expect(checkEmailThrottle('other@b.c').ok).toBe(true)
  })

  it('extractClientIp pins to the Nth-from-right XFF entry with TRUSTED_PROXY_HOPS', async () => {
    const { extractClientIp } = await import('@/lib/auth/authRateLimit')
    const r = (xff: string) => new Request('http://x', { headers: { 'x-forwarded-for': xff } })
    // Unset → leftmost (legacy; spoofable).
    expect(extractClientIp(r('1.1.1.1, 2.2.2.2'))).toBe('1.1.1.1')
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1')
    expect(extractClientIp(r('spoofed, 2.2.2.2'))).toBe('2.2.2.2') // rightmost = real client
    expect(extractClientIp(r('9.9.9.9'))).toBe('9.9.9.9')
    // 2 trusted proxies: XFF = "<spoofable>, <real client>, <inner proxy>" →
    // the real client is the (length-2)th entry.
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    expect(extractClientIp(r('spoofed, realClient, proxyHop'))).toBe('realClient')
  })

  it('fails closed (shared bucket) when TRUSTED_PROXY_HOPS exceeds the XFF depth', async () => {
    const { extractClientIp } = await import('@/lib/auth/authRateLimit')
    const r = (xff: string, realIp?: string) =>
      new Request('http://x', {
        headers: { 'x-forwarded-for': xff, ...(realIp ? { 'x-real-ip': realIp } : {}) },
      })
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3')
    // Only ONE XFF entry but 3 hops claimed → the leftmost is attacker-spoofable,
    // so we must NOT trust it. Fall back to x-real-ip, else a single 'local' bucket.
    expect(extractClientIp(r('1.2.3.4'))).not.toBe('1.2.3.4')
    expect(extractClientIp(r('1.2.3.4', '9.9.9.9'))).toBe('9.9.9.9')
    expect(extractClientIp(r('1.2.3.4'))).toBe('local')
  })

  it('collapses IPv6 to /64', async () => {
    const { extractClientIp } = await import('@/lib/auth/authRateLimit')
    const r = new Request('http://x', { headers: { 'x-forwarded-for': '2001:db8:1:2:3:4:5:6' } })
    expect(extractClientIp(r)).toBe('2001:db8:1:2::/64')
  })
})
