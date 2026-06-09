import { describe, it, expect, afterEach, vi } from 'vitest'
import { isFlagEnabled } from '@/lib/env/flag'

// SHE-8 — the canonical truthiness table for server-side env flags.
describe('isFlagEnabled', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('treats 1/true/yes/on (any case, trimmed) as enabled', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', ' true ', '  on']) {
      vi.stubEnv('SL_X', v)
      expect(isFlagEnabled('SL_X')).toBe(true)
    }
  })

  it('treats 0/false/no/off (any case) as disabled', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF', ' off ']) {
      vi.stubEnv('SL_X', v)
      expect(isFlagEnabled('SL_X')).toBe(false)
    }
  })

  it('falls back to the default when unset', () => {
    vi.stubEnv('SL_X', '')
    expect(isFlagEnabled('SL_X')).toBe(false)
    expect(isFlagEnabled('SL_X', { defaultOn: true })).toBe(true)
    // genuinely unset (not even '')
    expect(isFlagEnabled('SL_TOTALLY_UNSET_FLAG')).toBe(false)
    expect(isFlagEnabled('SL_TOTALLY_UNSET_FLAG', { defaultOn: true })).toBe(true)
  })

  it('falls back to the default for an unrecognized value (never treats unknown as on)', () => {
    for (const v of ['maybe', 'enabled', 'disabled', '2', 'truthy']) {
      vi.stubEnv('SL_X', v)
      expect(isFlagEnabled('SL_X')).toBe(false)
      expect(isFlagEnabled('SL_X', { defaultOn: true })).toBe(true)
    }
  })

  it('an explicit off/no/false overrides a defaultOn (the footgun this fixes)', () => {
    for (const v of ['off', 'no', 'false', '0']) {
      vi.stubEnv('SL_X', v)
      expect(isFlagEnabled('SL_X', { defaultOn: true })).toBe(false)
    }
  })

  it('reads the env fresh on every call', () => {
    vi.stubEnv('SL_X', '1')
    expect(isFlagEnabled('SL_X')).toBe(true)
    vi.stubEnv('SL_X', '0')
    expect(isFlagEnabled('SL_X')).toBe(false)
  })
})
