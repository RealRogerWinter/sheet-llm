// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(async () => {
  const { __resetForTesting } = await import('@/lib/orchestrator/requestRateLimit')
  __resetForTesting()
})
afterEach(() => vi.unstubAllEnvs())

describe('requestRateLimit', () => {
  it('per-IP allows up to the limit then 429s; other IPs unaffected', async () => {
    vi.stubEnv('SL_REQUEST_IP_RATE_LIMIT', '5')
    const { checkRequestIp } = await import('@/lib/orchestrator/requestRateLimit')
    for (let i = 0; i < 5; i++) expect(checkRequestIp('1.2.3.4').ok).toBe(true)
    const over = checkRequestIp('1.2.3.4')
    expect(over.ok).toBe(false)
    expect(over.retryAfterSec).toBeGreaterThan(0)
    expect(checkRequestIp('5.6.7.8').ok).toBe(true)
  })

  it('uses the default limit (60) when the env override is unset/invalid', async () => {
    vi.stubEnv('SL_REQUEST_IP_RATE_LIMIT', '') // unset/invalid → default
    const { checkRequestIp } = await import('@/lib/orchestrator/requestRateLimit')
    for (let i = 0; i < 60; i++) expect(checkRequestIp('9.9.9.9').ok).toBe(true)
    expect(checkRequestIp('9.9.9.9').ok).toBe(false)
  })
})
