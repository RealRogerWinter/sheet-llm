// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractClientIp } from '@/lib/http/clientIp'

afterEach(() => vi.unstubAllEnvs())

const req = (headers: Record<string, string>) => new Request('http://x/', { headers })

describe('extractClientIp', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For (unspoofable past Cloudflare)', () => {
    expect(
      extractClientIp(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': 'spoof, 1.2.3.4' })),
    ).toBe('203.0.113.9')
  })

  it('collapses a CF-Connecting-IP IPv6 to /64', () => {
    expect(extractClientIp(req({ 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' }))).toBe('2001:db8:1:2::/64')
  })

  it('falls back to hop-aware XFF when the CF header is absent', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    expect(extractClientIp(req({ 'x-forwarded-for': 'spoof, realClient, proxy' }))).toBe('realClient')
  })

  it('unset TRUSTED_PROXY_HOPS → leftmost XFF (legacy)', () => {
    expect(extractClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1')
  })

  it('fails closed (NOT the spoofable leftmost) when hops exceed the XFF depth', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3')
    // One XFF entry but 3 hops claimed → leftmost is attacker-spoofable, so we
    // must not trust it: fall back to x-real-ip, else the 'local' bucket.
    expect(extractClientIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('local')
    expect(extractClientIp(req({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
  })
})
