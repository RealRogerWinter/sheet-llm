import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computeKeyStatus } from '@/lib/orchestrator/keyStatus'

describe('orchestrator/keyStatus', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns false for all tiers when ANTHROPIC_API_KEY is missing', () => {
    const s = computeKeyStatus()
    expect(s).toEqual({ small: false, medium: false, large: false })
  })

  it('returns true for all tiers when ANTHROPIC_API_KEY is set (PR A default — all tiers anthropic)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const s = computeKeyStatus()
    expect(s).toEqual({ small: true, medium: true, large: true })
  })

  it('shape is stable across calls (each tier present, boolean type)', () => {
    const s = computeKeyStatus()
    expect(typeof s.small).toBe('boolean')
    expect(typeof s.medium).toBe('boolean')
    expect(typeof s.large).toBe('boolean')
  })

  it('PROVIDER_SMALL=groq + GROQ_API_KEY set → small=true regardless of ANTHROPIC_API_KEY', () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    vi.stubEnv('GROQ_API_KEY', 'gsk_test')
    const s = computeKeyStatus()
    expect(s.small).toBe(true)
  })

  it('PROVIDER_SMALL=groq + GROQ_API_KEY missing + ANTHROPIC_API_KEY set → small=true (fallback)', () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const s = computeKeyStatus()
    expect(s.small).toBe(true)
  })

  it('PROVIDER_SMALL=groq + neither key → small=false', () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    const s = computeKeyStatus()
    expect(s.small).toBe(false)
  })

  it('mixed per-tier: small=groq, medium=anthropic only → small misses without groq key', () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    vi.stubEnv('PROVIDER_MEDIUM', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    // PROVIDER_FALLBACK defaults to anthropic → small falls back to true.
    const s = computeKeyStatus()
    expect(s.small).toBe(true) // via fallback
    expect(s.medium).toBe(true) // direct anthropic
  })
})
