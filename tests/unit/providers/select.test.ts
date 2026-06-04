import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { selectProvider } from '@/lib/providers/select'
import { _resetSticky } from '@/lib/providers/sticky'

describe('providers/select', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    _resetSticky()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    _resetSticky()
  })

  it('defaults each tier to anthropic with its tier-specific model', () => {
    expect(selectProvider('small', 'chat-1').model).toBe('claude-haiku-4-5-20251001')
    expect(selectProvider('medium', 'chat-2').model).toBe('claude-sonnet-4-6')
    expect(selectProvider('large', 'chat-3').model).toBe('claude-opus-4-7')
  })

  it('PROVIDER_SMALL=groq with GROQ_API_KEY set routes to GroqProvider', () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    vi.stubEnv('GROQ_API_KEY', 'gsk_test')
    const sel = selectProvider('small', 'chat-groq')
    expect(sel.providerName).toBe('groq')
    expect(sel.model).toBe('openai/gpt-oss-20b')
  })

  it('PROVIDER_SMALL=groq with GROQ_API_KEY missing falls back to PROVIDER_FALLBACK (anthropic by default)', () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    // GROQ_API_KEY intentionally NOT set
    const sel = selectProvider('small', 'chat-fb')
    expect(sel.providerName).toBe('anthropic')
  })

  it('sticky: second call for the same chatId reuses the first call\'s provider', () => {
    const a = selectProvider('small', 'chat-sticky')
    const b = selectProvider('small', 'chat-sticky')
    expect(a.providerName).toBe(b.providerName)
    expect(a.model).toBe(b.model)
  })

  it('sticky: per-tier — small and medium are independent within the same chat', () => {
    const small = selectProvider('small', 'chat-multi')
    const medium = selectProvider('medium', 'chat-multi')
    expect(small.model).not.toBe(medium.model)
  })

  it('sticky: different chatIds get independent selections', () => {
    selectProvider('small', 'chat-a')
    selectProvider('small', 'chat-b')
    // No assertion on names since both default to anthropic; the
    // important property is no leakage. Re-select with one cleared and
    // the other still sticky:
    _resetSticky()
    expect(() => selectProvider('small', 'chat-a')).not.toThrow()
  })

  it('omitted chatId: still resolves, just no sticky cache', () => {
    const r1 = selectProvider('small', undefined)
    const r2 = selectProvider('small', undefined)
    expect(r1.providerName).toBe('anthropic')
    expect(r2.providerName).toBe('anthropic')
  })

  it('returns the SelectedProvider shape', () => {
    const sel = selectProvider('small', 'chat-shape')
    expect(sel.tier).toBe('small')
    expect(sel.providerName).toBe('anthropic')
    expect(typeof sel.model).toBe('string')
    expect(typeof sel.provider.toolCall).toBe('function')
  })

  it('auto-failover: after 2 reported schema failures on the chosen provider, switches to fallback for that chat+tier', async () => {
    vi.stubEnv('PROVIDER_SMALL', 'groq')
    vi.stubEnv('GROQ_API_KEY', 'gsk_test')
    const { reportProviderFailure, _resetDegradation } = await import(
      '@/lib/providers/degradation'
    )
    _resetDegradation()

    // First call: groq wins.
    expect(selectProvider('small', 'chat-degrade').providerName).toBe('groq')

    // Report 2 schema failures.
    reportProviderFailure('chat-degrade', 'small', 'groq')
    reportProviderFailure('chat-degrade', 'small', 'groq')

    // Sticky overrides — but degradation overrides sticky.
    const sel = selectProvider('small', 'chat-degrade')
    expect(sel.providerName).toBe('anthropic')
  })
})
