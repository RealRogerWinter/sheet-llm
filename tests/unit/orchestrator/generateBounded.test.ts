import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const callWithScoreRetryMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/scoreRetry', () => ({
  callWithScoreRetry: callWithScoreRetryMock,
}))
vi.mock('@/lib/providers/select', () => ({
  selectProvider: () => ({ provider: {}, providerName: 'anthropic', tier: 'medium', model: 'claude-sonnet-4-6' }),
}))

const { runGenerateBounded } = await import('@/lib/orchestrator/handlers/generateBounded')
const {
  policyFor,
  getGenerationTier,
  isForceFreeTier,
  resolveGenerationTier,
  BOUNDED_EMIT_CEILING,
  BOUNDED_MAX_BARS,
} = await import('@/lib/orchestrator/generationTier')
const { BOUNDED_GENERATION_RULES, MULTI_STAFF_REFERENCE } = await import('@/lib/llm/systemPrompt')

const SCORE = {
  title: 'x',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
}

describe('generationTier — policy + resolver', () => {
  beforeEach(() => vi.unstubAllEnvs())

  it('free policy: bounded ceiling, 4-bar cap, no sectional/whole-score', () => {
    const p = policyFor('free')
    expect(p.maxOutputTokens).toBe(2600)
    expect(p.maxOutputTokens).toBe(BOUNDED_EMIT_CEILING)
    expect(p.maxBars).toBe(BOUNDED_MAX_BARS)
    expect(BOUNDED_MAX_BARS).toBe(4)
    expect(p.allowSectional).toBe(false)
    expect(p.allowWholeScore).toBe(false)
  })

  it('pro policy restores full generation', () => {
    const p = policyFor('pro')
    expect(p.allowSectional).toBe(true)
    expect(p.allowWholeScore).toBe(true)
  })

  it('default tier is free; SL_GENERATION_TIER=pro flips it', () => {
    expect(getGenerationTier()).toBe('free')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    expect(getGenerationTier()).toBe('pro')
  })

  it('SL_FORCE_FREE_TIER forces free even when tier=pro', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    vi.stubEnv('SL_FORCE_FREE_TIER', '1')
    expect(isForceFreeTier()).toBe(true)
    expect(await resolveGenerationTier('user-1')).toBe('free')
  })

  it('resolveGenerationTier falls back to the env default with no userId', async () => {
    expect(await resolveGenerationTier()).toBe('free')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    expect(await resolveGenerationTier()).toBe('pro')
  })

  it('a debug override beats the env default + entitlement', async () => {
    // override wins even with no userId and an opposing env default
    expect(await resolveGenerationTier(undefined, 'pro')).toBe('pro')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    expect(await resolveGenerationTier('user-1', 'free')).toBe('free')
  })

  it('the operator force-free kill switch still trumps a pro debug override', async () => {
    vi.stubEnv('SL_FORCE_FREE_TIER', '1')
    expect(await resolveGenerationTier('user-1', 'pro')).toBe('free')
    expect(await resolveGenerationTier(undefined, 'pro')).toBe('free')
  })
})

describe('runGenerateBounded — bounded single-call contract', () => {
  beforeEach(() => {
    callWithScoreRetryMock.mockReset()
    callWithScoreRetryMock.mockResolvedValue({
      input: SCORE,
      toolUseId: 'toolu_b',
      model: 'claude-sonnet-4-6',
      introText: 'ok',
      usage: { inputTokens: 10, outputTokens: 20 },
    })
    vi.unstubAllEnvs()
  })

  it('makes EXACTLY ONE render_score call with the kill-switch ceiling, cost knobs, and cached frozen prefix', async () => {
    const res = await runGenerateBounded({
      classification: { kind: 'generate_complex', scope: 'short', complexity: 'simple', confidence: 1 },
      chatId: 'c1',
      userText: 'a tune',
    })
    expect(callWithScoreRetryMock).toHaveBeenCalledTimes(1)
    const opts = callWithScoreRetryMock.mock.calls[0][1]
    expect(opts.maxTokens).toBe(2600)
    expect(opts.maxTokens).toBe(BOUNDED_EMIT_CEILING)
    expect(opts.effort).toBe('low')
    expect(opts.thinking).toBe('disabled')
    expect(opts.maxRetries).toBe(1)
    expect(opts.providerOptions.anthropic.cacheControl).toBe('ephemeral')
    expect(opts.systemPrompt[0].text).toBe(BOUNDED_GENERATION_RULES)
    expect(opts.systemPrompt[1]).toEqual({ text: MULTI_STAFF_REFERENCE, cache: true })
    expect(opts.userText).toContain('a tune')
    expect(opts.userText.toLowerCase()).toContain('at most 4 bars')
    expect(res.score).toBe(SCORE)
    expect(res.toolUseId).toBe('toolu_b')
  })

  it('honors a tighter policy ceiling override', async () => {
    await runGenerateBounded({
      classification: { kind: 'generate_complex', scope: 'short', complexity: 'simple', confidence: 1 },
      chatId: 'c2',
      userText: 'x',
      maxOutputTokens: 1800,
    })
    expect(callWithScoreRetryMock.mock.calls[0][1].maxTokens).toBe(1800)
  })
})

describe('bounded handler source invariants (drift guards)', () => {
  const root = process.cwd()

  it('BOUNDED_EMIT_CEILING sits in the bounded band (2000..2600)', () => {
    const src = readFileSync(path.join(root, 'src/lib/orchestrator/generationTier.ts'), 'utf8')
    const m = src.match(/const BOUNDED_EMIT_CEILING = ([\d_]+)/)
    expect(m).toBeTruthy()
    const n = Number(m![1].replace(/_/g, ''))
    expect(n).toBeGreaterThanOrEqual(2000)
    expect(n).toBeLessThanOrEqual(2600)
  })

  it('generateBounded.ts defines NO (SECTION_)?MAX_TOKENS const (would re-arm the >=8000 drift guard)', () => {
    const src = readFileSync(path.join(root, 'src/lib/orchestrator/handlers/generateBounded.ts'), 'utf8')
    expect(src).not.toMatch(/const\s+(?:SECTION_)?MAX_TOKENS\s*=/)
  })

  it('generateBounded.ts is NOT listed in tokenBudget.test.ts RENDER_SCORE_EMITTERS', () => {
    const src = readFileSync(path.join(root, 'tests/unit/orchestrator/tokenBudget.test.ts'), 'utf8')
    expect(src).not.toContain('handlers/generateBounded.ts')
  })

  it('BOUNDED_GENERATION_RULES is byte-frozen (no template interpolation)', () => {
    const src = readFileSync(path.join(root, 'src/lib/llm/systemPrompt.ts'), 'utf8')
    const marker = 'export const BOUNDED_GENERATION_RULES = `'
    const start = src.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const bodyStart = start + marker.length
    const end = src.indexOf('`', bodyStart)
    const body = src.slice(bodyStart, end)
    expect(body).not.toContain('${')
  })
})
