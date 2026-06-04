// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(40))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Turnstile clearance (signed, IP-bound)', () => {
  it('round-trips a valid clearance for the same IP', async () => {
    const { makeClearanceValue, checkClearanceValue } = await import('@/lib/security/turnstile')
    const v = makeClearanceValue('1.2.3.4')
    expect(checkClearanceValue(v, '1.2.3.4')).toBe(true)
  })

  it('rejects a clearance presented from a different IP', async () => {
    const { makeClearanceValue, checkClearanceValue } = await import('@/lib/security/turnstile')
    expect(checkClearanceValue(makeClearanceValue('1.2.3.4'), '9.9.9.9')).toBe(false)
  })

  it('rejects an expired clearance', async () => {
    const { makeClearanceValue, checkClearanceValue } = await import('@/lib/security/turnstile')
    const issuedLongAgo = Date.now() - 60 * 60 * 1000
    expect(checkClearanceValue(makeClearanceValue('1.2.3.4', issuedLongAgo), '1.2.3.4')).toBe(false)
  })

  it('rejects a tampered signature', async () => {
    const { makeClearanceValue, checkClearanceValue } = await import('@/lib/security/turnstile')
    const v = makeClearanceValue('1.2.3.4')
    const tampered = v.slice(0, -2) + (v.endsWith('aa') ? 'bb' : 'aa')
    expect(checkClearanceValue(tampered, '1.2.3.4')).toBe(false)
  })

  it('rejects garbage / empty values', async () => {
    const { checkClearanceValue } = await import('@/lib/security/turnstile')
    expect(checkClearanceValue('not-a-value', '1.2.3.4')).toBe(false)
    expect(checkClearanceValue('', '1.2.3.4')).toBe(false)
  })
})

describe('isTurnstileEnabled', () => {
  it('is off until BOTH keys are set', async () => {
    const { isTurnstileEnabled } = await import('@/lib/security/turnstile')
    expect(isTurnstileEnabled()).toBe(false)
    vi.stubEnv('TURNSTILE_SITE_KEY', '0xsite')
    expect(isTurnstileEnabled()).toBe(false)
    vi.stubEnv('TURNSTILE_SECRET_KEY', '0xsecret')
    expect(isTurnstileEnabled()).toBe(true)
  })
})

describe('verifyTurnstileToken (siteverify)', () => {
  it('false without a secret or token', async () => {
    const { verifyTurnstileToken } = await import('@/lib/security/turnstile')
    expect(await verifyTurnstileToken('', '1.2.3.4')).toBe(false)
  })

  it('true on a successful siteverify', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '0xsecret')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))
    const { verifyTurnstileToken } = await import('@/lib/security/turnstile')
    expect(await verifyTurnstileToken('tok', '1.2.3.4')).toBe(true)
  })

  it('false on a failed siteverify', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '0xsecret')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })))
    const { verifyTurnstileToken } = await import('@/lib/security/turnstile')
    expect(await verifyTurnstileToken('tok', '1.2.3.4')).toBe(false)
  })
})
