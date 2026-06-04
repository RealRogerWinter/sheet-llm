import { describe, it, expect } from 'vitest'
import { buildDebugOverrides } from '@/lib/debug/debugStore'

describe('buildDebugOverrides — paywall tier toggle', () => {
  it("omits generationTier when the toggle is 'auto' (server resolves the tier)", () => {
    // auto + nothing else overridden -> no debug object at all
    expect(buildDebugOverrides('auto', '', '', 'auto')).toBeUndefined()
  })

  it("maps 'free' -> generationTier: 'free' (paywall ON)", () => {
    expect(buildDebugOverrides('auto', '', '', 'free')).toEqual({ generationTier: 'free' })
  })

  it("maps 'pro' -> generationTier: 'pro' (paywall OFF)", () => {
    expect(buildDebugOverrides('auto', '', '', 'pro')).toEqual({ generationTier: 'pro' })
  })

  it('defaults to auto when the tier arg is omitted (back-compat with the 3-arg call)', () => {
    expect(buildDebugOverrides('auto', '', '')).toBeUndefined()
  })

  it('combines the tier override with the other debug overrides', () => {
    expect(buildDebugOverrides('on', 'claude-haiku-4-5-20251001', '', 'pro')).toEqual({
      orchestrator: 'on',
      modelOverride: 'claude-haiku-4-5-20251001',
      generationTier: 'pro',
    })
  })
})
