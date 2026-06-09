// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// SHE-8 PR-3 — the BYOK anti-DoS limiter is INDEPENDENT of the token-cost
// limiter (requestRateLimit). A BYOK abuser hitting our shared infra is bounded
// here without touching the spend budget.

beforeEach(async () => {
  const { __resetForTesting } = await import('@/lib/orchestrator/byokRateLimit')
  __resetForTesting()
})
afterEach(() => vi.unstubAllEnvs())

describe('byokRateLimit', () => {
  it('per-IP allows up to the limit then 429s; other IPs unaffected', async () => {
    vi.stubEnv('SL_BYOK_IP_RATE_LIMIT', '4')
    const { checkByokIp } = await import('@/lib/orchestrator/byokRateLimit')
    for (let i = 0; i < 4; i++) expect(checkByokIp('1.2.3.4').ok).toBe(true)
    const over = checkByokIp('1.2.3.4')
    expect(over.ok).toBe(false)
    expect(over.retryAfterSec).toBeGreaterThan(0)
    expect(checkByokIp('5.6.7.8').ok).toBe(true)
  })

  it('uses the default limit (30) when the env override is unset/invalid', async () => {
    vi.stubEnv('SL_BYOK_IP_RATE_LIMIT', '') // unset/invalid → default
    const { checkByokIp } = await import('@/lib/orchestrator/byokRateLimit')
    for (let i = 0; i < 30; i++) expect(checkByokIp('9.9.9.9').ok).toBe(true)
    expect(checkByokIp('9.9.9.9').ok).toBe(false)
  })

  it('is a SEPARATE bucket from requestRateLimit (no shared state)', async () => {
    vi.stubEnv('SL_BYOK_IP_RATE_LIMIT', '1')
    vi.stubEnv('SL_REQUEST_IP_RATE_LIMIT', '5')
    const { checkByokIp } = await import('@/lib/orchestrator/byokRateLimit')
    const { checkRequestIp, __resetForTesting: resetReq } = await import(
      '@/lib/orchestrator/requestRateLimit'
    )
    resetReq()
    expect(checkByokIp('7.7.7.7').ok).toBe(true)
    expect(checkByokIp('7.7.7.7').ok).toBe(false) // byok bucket exhausted at 1
    // The token-cost limiter for the same IP is untouched.
    expect(checkRequestIp('7.7.7.7').ok).toBe(true)
  })
})
