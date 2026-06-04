// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cidrContains, expandIpv6, networkPrefix } from '@/lib/security/ipMath'

describe('expandIpv6', () => {
  it('expands :: and abbreviated forms to 8 hextets', () => {
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(expandIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
  it('handles a trailing IPv4-mapped quad', () => {
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
  })
  it('rejects malformed input', () => {
    expect(expandIpv6('2001:db8::1::2')).toBeNull()
    expect(expandIpv6('xyz')).toBeNull()
  })
})

describe('networkPrefix', () => {
  it('truncates IPv4 to /24', () => {
    expect(networkPrefix('1.2.3.4', 24, 56)).toBe('1.2.3.0/24')
    expect(networkPrefix('1.2.3.255', 24, 56)).toBe('1.2.3.0/24')
  })
  it('truncates IPv6 to /56 — abbreviated forms collapse identically (fixes the normalizeIp bug)', () => {
    const a = networkPrefix('2001:db8::1', 24, 56)
    const b = networkPrefix('2001:db8::1234', 24, 56)
    expect(a).not.toBeNull()
    expect(a).toBe(b) // /64-self-rotation within a /56 cannot mint a fresh key
  })
  it('returns null for an unparseable address', () => {
    expect(networkPrefix('not-an-ip', 24, 56)).toBeNull()
  })
})

describe('cidrContains', () => {
  it('matches IPv4 ranges', () => {
    expect(cidrContains('10.0.0.0/8', '10.1.2.3')).toBe(true)
    expect(cidrContains('10.0.0.0/8', '11.1.2.3')).toBe(false)
    expect(cidrContains('1.2.3.0/24', '1.2.3.255')).toBe(true)
    expect(cidrContains('1.2.3.0/24', '1.2.4.0')).toBe(false)
  })
  it('matches IPv6 ranges', () => {
    expect(cidrContains('2001:db8::/32', '2001:db8:dead:beef::1')).toBe(true)
    expect(cidrContains('2001:db8::/32', '2001:db9::1')).toBe(false)
  })
  it('is false on version mismatch or malformed CIDR', () => {
    expect(cidrContains('10.0.0.0/8', '::1')).toBe(false)
    expect(cidrContains('not-a-cidr', '1.2.3.4')).toBe(false)
  })
})
