import { describe, it, expect, vi, afterEach } from 'vitest'
import { isByokKeyAccepted } from '@/lib/orchestrator/generationTier'

// SHE-8 PR-3 — `debug.apiKey` (BYOK) is a CLIENT-SUPPLIED field plumbed into the
// provider as `apiKeyOverride`. Honoring it UNCONDITIONALLY on the hosted demo
// is a key-laundering / billing-evasion primitive, so it is default-DENY,
// fail-closed — mirroring `isTierOverrideAllowed`. There is no edition primitive
// yet, so an explicit `SL_BYOK_ALLOWED` opt-in is the OSS/desktop/self-host signal.

describe('isByokKeyAccepted', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is TRUE in development and test (the developer is using their own key)', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(isByokKeyAccepted()).toBe(true)
    vi.stubEnv('NODE_ENV', 'test')
    expect(isByokKeyAccepted()).toBe(true)
  })

  it('is FALSE in production with no opt-in (hosted fail-closed)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_BYOK_ALLOWED', '')
    expect(isByokKeyAccepted()).toBe(false)
  })

  it('does NOT fail open on an unset/odd NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'staging')
    expect(isByokKeyAccepted()).toBe(false)
    vi.stubEnv('NODE_ENV', '')
    expect(isByokKeyAccepted()).toBe(false)
  })

  it('honors an explicit SL_BYOK_ALLOWED opt-in in production (OSS/desktop/self-host)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    for (const v of ['1', 'true', 'TRUE']) {
      vi.stubEnv('SL_BYOK_ALLOWED', v)
      expect(isByokKeyAccepted()).toBe(true)
    }
  })

  it('stays OFF in production for any non-truthy opt-in value', () => {
    vi.stubEnv('NODE_ENV', 'production')
    for (const v of ['0', 'false', 'no', 'off', 'yes', 'enabled']) {
      vi.stubEnv('SL_BYOK_ALLOWED', v)
      expect(isByokKeyAccepted()).toBe(false)
    }
  })
})
