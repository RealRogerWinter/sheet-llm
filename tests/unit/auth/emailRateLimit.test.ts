// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(async () => {
  const { __resetEmailRateForTesting } = await import('@/lib/auth/emailRateLimit')
  __resetEmailRateForTesting()
})

describe('emailRateLimit / checkEmailSend', () => {
  it('per-destination: allows the limit then blocks; other destination unaffected', async () => {
    const { checkEmailSend } = await import('@/lib/auth/emailRateLimit')
    for (let i = 0; i < 5; i++) {
      expect(checkEmailSend({ email: 'a@b.c', ip: `ip-${i}` }).ok).toBe(true)
    }
    const over = checkEmailSend({ email: 'a@b.c', ip: 'ip-new' })
    expect(over.ok).toBe(false)
    expect(over.retryAfterSec).toBeGreaterThan(0)
    expect(checkEmailSend({ email: 'other@b.c', ip: 'ip-z' }).ok).toBe(true)
  })

  it('per-IP: one IP can only trigger the IP limit across many destinations', async () => {
    const { checkEmailSend } = await import('@/lib/auth/emailRateLimit')
    for (let i = 0; i < 15; i++) {
      expect(checkEmailSend({ email: `d${i}@b.c`, ip: '9.9.9.9' }).ok).toBe(true)
    }
    expect(checkEmailSend({ email: 'd-final@b.c', ip: '9.9.9.9' }).ok).toBe(false)
    expect(checkEmailSend({ email: 'd-final@b.c', ip: '8.8.8.8' }).ok).toBe(true) // other IP fine
  })

  it('a blocked send records nothing (a fresh destination/IP still goes through)', async () => {
    const { checkEmailSend } = await import('@/lib/auth/emailRateLimit')
    for (let i = 0; i < 5; i++) checkEmailSend({ email: 'a@b.c', ip: `ip-${i}` })
    expect(checkEmailSend({ email: 'a@b.c', ip: 'ip-x' }).ok).toBe(false) // dest full → blocked
    // The blocked attempt did not consume ip-x's or the global budget.
    expect(checkEmailSend({ email: 'fresh@b.c', ip: 'ip-x' }).ok).toBe(true)
  })

  it('instance-wide budget blocks after the global limit, even across distinct dest+IP', async () => {
    const { checkEmailSend } = await import('@/lib/auth/emailRateLimit')
    for (let i = 0; i < 1000; i++) {
      expect(checkEmailSend({ email: `u${i}@b.c`, ip: `ip${i}` }).ok).toBe(true)
    }
    expect(checkEmailSend({ email: 'u1000@b.c', ip: 'ip1000' }).ok).toBe(false)
  })
})
