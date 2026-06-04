// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetForTesting,
  checkIp,
  checkSub,
  extractClientIp,
} from '@/lib/auth/restoreRateLimit'

beforeEach(() => {
  __resetForTesting()
})

afterEach(() => {
  __resetForTesting()
})

describe('checkIp / checkSub sliding window', () => {
  it('allows up to 10 hits in a window then denies the 11th', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkIp('1.2.3.4').ok).toBe(true)
    }
    const eleventh = checkIp('1.2.3.4')
    expect(eleventh.ok).toBe(false)
    expect(eleventh.retryAfterSec).toBeGreaterThan(0)
  })

  it('tracks IPs independently', () => {
    for (let i = 0; i < 10; i++) checkIp('1.1.1.1')
    expect(checkIp('1.1.1.1').ok).toBe(false)
    expect(checkIp('2.2.2.2').ok).toBe(true)
  })

  it('per-sub bucket is independent of per-IP', () => {
    for (let i = 0; i < 10; i++) checkSub('user-1')
    expect(checkSub('user-1').ok).toBe(false)
    expect(checkIp('1.1.1.1').ok).toBe(true)
  })
})

describe('extractClientIp', () => {
  it('reads the first value of x-forwarded-for', () => {
    const req = new Request('http://x/', {
      headers: { 'x-forwarded-for': '203.0.113.5, 70.41.3.18, 150.172.238.178' },
    })
    expect(extractClientIp(req)).toBe('203.0.113.5')
  })

  it('falls back to x-real-ip', () => {
    const req = new Request('http://x/', {
      headers: { 'x-real-ip': '198.51.100.7' },
    })
    expect(extractClientIp(req)).toBe('198.51.100.7')
  })

  it('falls back to "local" sentinel when neither header is present', () => {
    const req = new Request('http://x/')
    expect(extractClientIp(req)).toBe('local')
  })

  it('collapses IPv6 to /64 prefix', () => {
    const req = new Request('http://x/', {
      headers: { 'x-forwarded-for': '2001:db8:85a3:8d3:1319:8a2e:370:7348' },
    })
    expect(extractClientIp(req)).toBe('2001:db8:85a3:8d3::/64')
  })

  it('leaves IPv4 alone', () => {
    const req = new Request('http://x/', {
      headers: { 'x-forwarded-for': '192.0.2.1' },
    })
    expect(extractClientIp(req)).toBe('192.0.2.1')
  })
})
