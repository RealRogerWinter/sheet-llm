import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveGenerationTier,
  isTierOverrideAllowed,
  isAdvancedComposerEnabled,
  policyFor,
  toTierPolicy,
} from '@/lib/orchestrator/generationTier'

// PR-0 (paywall integrity): `debug.generationTier` is a CLIENT-SUPPLIED field
// parsed off the chat POST body. Honoring it unconditionally let any caller
// send `debug.generationTier='pro'` and unlock whole-score generation for free.
// resolveGenerationTier now gates it behind isTierOverrideAllowed().

describe('isTierOverrideAllowed', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('honors explicit dev and test contexts', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(isTierOverrideAllowed()).toBe(true)
    vi.stubEnv('NODE_ENV', 'test')
    expect(isTierOverrideAllowed()).toBe(true)
  })

  it('denies production by default', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', '')
    expect(isTierOverrideAllowed()).toBe(false)
  })

  it('default-DENIES an unrecognized or unset env (fail-closed)', () => {
    // A `NODE_ENV !== 'production'` check would fail OPEN here. Default-deny
    // keeps the override off unless the env is an explicitly trusted dev/test.
    vi.stubEnv('NODE_ENV', 'staging')
    expect(isTierOverrideAllowed()).toBe(false)
    vi.stubEnv('NODE_ENV', '')
    expect(isTierOverrideAllowed()).toBe(false)
  })

  it('honors the opt-in (1 or true) in an untrusted env', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', '1')
    expect(isTierOverrideAllowed()).toBe(true)
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', 'true')
    expect(isTierOverrideAllowed()).toBe(true)
  })
})

describe('resolveGenerationTier — client override gating', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('IGNORES a client "pro" override in production (no opt-in) — the bypass fix', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', '')
    vi.stubEnv('SL_FORCE_FREE_TIER', '')
    vi.stubEnv('SL_GENERATION_TIER', '') // env default => free
    await expect(resolveGenerationTier(undefined, 'pro')).resolves.toBe('free')
  })

  it('HONORS the override in production when SL_ALLOW_TIER_OVERRIDE=1', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', '1')
    vi.stubEnv('SL_FORCE_FREE_TIER', '')
    await expect(resolveGenerationTier(undefined, 'pro')).resolves.toBe('pro')
  })

  it('HONORS the override outside production (dev/test)', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SL_FORCE_FREE_TIER', '')
    await expect(resolveGenerationTier(undefined, 'pro')).resolves.toBe('pro')
  })

  it('the operator force-free kill switch still beats an allowed override', async () => {
    vi.stubEnv('NODE_ENV', 'development') // override would be allowed...
    vi.stubEnv('SL_FORCE_FREE_TIER', '1') // ...but the kill switch wins
    await expect(resolveGenerationTier(undefined, 'pro')).resolves.toBe('free')
  })

  it('falls back to the env default when no override is supplied', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_FORCE_FREE_TIER', '')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    await expect(resolveGenerationTier(undefined, undefined)).resolves.toBe('pro')
  })

  it('ignores a gated-off override but still consults the env default (override ignored != env ignored)', async () => {
    vi.stubEnv('NODE_ENV', 'production') // override not honored...
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', '')
    vi.stubEnv('SL_FORCE_FREE_TIER', '')
    vi.stubEnv('SL_GENERATION_TIER', 'pro') // ...but the env default still applies
    await expect(resolveGenerationTier(undefined, 'free')).resolves.toBe('pro')
  })

  it('fail-closed: an unset NODE_ENV ignores the client override (=> env default free)', async () => {
    vi.stubEnv('NODE_ENV', '')
    vi.stubEnv('SL_ALLOW_TIER_OVERRIDE', '')
    vi.stubEnv('SL_FORCE_FREE_TIER', '')
    vi.stubEnv('SL_GENERATION_TIER', '')
    await expect(resolveGenerationTier(undefined, 'pro')).resolves.toBe('free')
  })
})

describe('isAdvancedComposerEnabled (PR-8 — Opus routing operator flag)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is OFF by default (dark) so the toggle is ignored until launch', () => {
    vi.stubEnv('SL_ADVANCED_COMPOSER', '')
    expect(isAdvancedComposerEnabled()).toBe(false)
  })

  it('honors the 1 / true opt-in', () => {
    vi.stubEnv('SL_ADVANCED_COMPOSER', '1')
    expect(isAdvancedComposerEnabled()).toBe(true)
    vi.stubEnv('SL_ADVANCED_COMPOSER', 'true')
    expect(isAdvancedComposerEnabled()).toBe(true)
    vi.stubEnv('SL_ADVANCED_COMPOSER', 'TRUE')
    expect(isAdvancedComposerEnabled()).toBe(true)
  })

  // SHE-8: the flag now goes through the canonical isFlagEnabled truthiness,
  // which ALSO accepts yes/on (a superset of the old 1/true-only parse).
  it('also honors yes / on (SHE-8 canonical truthiness)', () => {
    for (const v of ['yes', 'YES', 'on', 'ON']) {
      vi.stubEnv('SL_ADVANCED_COMPOSER', v)
      expect(isAdvancedComposerEnabled()).toBe(true)
    }
  })

  it('stays OFF for 0 / false / no / off and unrecognized values', () => {
    for (const v of ['0', 'false', 'no', 'off', 'enabled', 'maybe']) {
      vi.stubEnv('SL_ADVANCED_COMPOSER', v)
      expect(isAdvancedComposerEnabled()).toBe(false)
    }
  })
})

// SHE-8 — `toTierPolicy` is the SaaS adapter the route injects into the
// orchestrator (which no longer imports `policyFor`). These pin the mapping so a
// future free-tier restriction added to `POLICY` can't silently fail to reach
// the kernel: every cap is asserted to derive from `policyFor`, and the free
// tier must stay fail-closed (bounded + no sectional/whole-score).
describe('toTierPolicy (SHE-8 injected-policy adapter)', () => {
  it('maps free to a fully capped, bounded policy derived from policyFor', () => {
    const free = policyFor('free')
    expect(toTierPolicy('free')).toEqual({
      allowSectional: free.allowSectional,
      allowWholeScore: free.allowWholeScore,
      maxBars: free.maxBars,
      emitCeiling: free.maxOutputTokens,
      useBoundedFallback: true,
    })
    // Concrete fail-closed guarantee for the free tier.
    expect(toTierPolicy('free')).toMatchObject({
      allowSectional: false,
      allowWholeScore: false,
      useBoundedFallback: true,
    })
  })

  it('maps pro to the full pipeline (no bounded fallback) derived from policyFor', () => {
    const pro = policyFor('pro')
    expect(toTierPolicy('pro')).toEqual({
      allowSectional: pro.allowSectional,
      allowWholeScore: pro.allowWholeScore,
      maxBars: pro.maxBars,
      emitCeiling: pro.maxOutputTokens,
      useBoundedFallback: false,
    })
    expect(toTierPolicy('pro')).toMatchObject({
      allowSectional: true,
      allowWholeScore: true,
      useBoundedFallback: false,
    })
  })
})
