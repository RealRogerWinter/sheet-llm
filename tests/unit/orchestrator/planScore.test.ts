import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirror generateComplexAndCompose.test.ts: mock the Anthropic SDK so the
// planner's callWithFailover -> AnthropicProvider.toolCall hits a stub
// instead of the network.
const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {}
    static RateLimitError = class extends Error {}
  }
  return { default: MockAnthropic }
})

const {
  runPlanScore,
  planToSegments,
  totalPlannedBars,
  fallbackPlan,
  ScorePlanSchema,
  MAX_SECTION_BARS,
} = await import('@/lib/orchestrator/handlers/planScore')

type Plan = import('@/lib/orchestrator/handlers/planScore').ScorePlan

const BLUES_FUNK_PLAN: Plan = {
  title: 'Blues-Funk Groove',
  key: 'C',
  meter: '4/4',
  tempo_bpm: 112,
  clef: 'treble',
  grandStaff: true,
  sections: [
    { label: 'A', bars: 8, hint: 'syncopated C7 funk stabs over an octave bass' },
    { label: 'B', bars: 6, hint: 'move to F7 and back' },
    { label: 'Turnaround', bars: 2, hint: 'Dm7-G7-C7 turnaround' },
  ],
}

function toolResponse(input: unknown): unknown {
  return {
    content: [{ type: 'tool_use', id: 'toolu_plan', name: 'emit_score_plan', input }],
    usage: { input_tokens: 300, output_tokens: 200 },
  }
}

describe('orchestrator/handlers/planScore — runPlanScore', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('returns the parsed plan from the model tool call', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(BLUES_FUNK_PLAN))
    const result = await runPlanScore({ userText: 'a driving blues-funk piece, 16 bars, grand staff, turnaround', chatId: 'c1' })
    expect(result.plan).toEqual(BLUES_FUNK_PLAN)
    expect(result.model).not.toBe('fallback')
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 200, cachedInputTokens: undefined })
    expect(totalPlannedBars(result.plan)).toBe(16)
  })

  it('issues a single bounded planner tool call (small max_tokens, named tool)', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(BLUES_FUNK_PLAN))
    await runPlanScore({ userText: 'plan something', chatId: 'c1' })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.max_tokens).toBeLessThanOrEqual(1000)
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'emit_score_plan' })
    expect(call.tools[0].name).toBe('emit_score_plan')
  })

  it('falls back to a deterministic single-section plan when the model output is malformed', async () => {
    // Missing the required `sections` array -> ScorePlanSchema parse fails
    // -> AnthropicProvider throws ProviderSchemaError -> runPlanScore degrades.
    anthropicCreateMock.mockResolvedValue(toolResponse({ key: 'C', meter: '4/4', grandStaff: false }))
    const result = await runPlanScore({ userText: 'whatever', chatId: 'c1' })
    expect(result.model).toBe('fallback')
    expect(result.plan.sections).toHaveLength(1)
    expect(ScorePlanSchema.safeParse(result.plan).success).toBe(true)
  })

  it('falls back (not throws) when the provider call rejects', async () => {
    anthropicCreateMock.mockRejectedValue(new Error('network down'))
    const result = await runPlanScore({ userText: 'whatever', chatId: 'c1' })
    expect(result.model).toBe('fallback')
    expect(result.plan.sections).toHaveLength(1)
  })
})

describe('orchestrator/handlers/planScore — planToSegments (pure)', () => {
  it('keeps sections that already fit under the segment cap', () => {
    const segs = planToSegments(BLUES_FUNK_PLAN)
    expect(segs.map((s) => s.bars)).toEqual([8, 6, 2])
    expect(segs[0].isFirst).toBe(true)
    expect(segs.slice(1).every((s) => !s.isFirst)).toBe(true)
    expect(segs.map((s) => s.sectionLabel)).toEqual(['A', 'B', 'Turnaround'])
  })

  it('splits an over-long section into <= MAX_SECTION_BARS segments carrying the same label/hint', () => {
    const plan: Plan = { key: 'C', meter: '4/4', grandStaff: false, sections: [{ label: 'A', bars: 20, hint: 'h' }] }
    const segs = planToSegments(plan)
    expect(segs.map((s) => s.bars)).toEqual([MAX_SECTION_BARS, MAX_SECTION_BARS, 4]) // 8+8+4 = 20
    expect(segs.every((s) => s.sectionLabel === 'A' && s.hint === 'h')).toBe(true)
    expect(segs.reduce((n, s) => n + s.bars, 0)).toBe(20)
  })

  it('preserves total bars and reindexes sequentially', () => {
    const segs = planToSegments(BLUES_FUNK_PLAN, 4)
    expect(segs.reduce((n, s) => n + s.bars, 0)).toBe(16)
    expect(segs.map((s) => s.index)).toEqual(segs.map((_, i) => i))
  })
})

describe('orchestrator/handlers/planScore — fallbackPlan', () => {
  it('produces a schema-valid single-section plan with sensible defaults', () => {
    const p = fallbackPlan()
    expect(ScorePlanSchema.safeParse(p).success).toBe(true)
    expect(p.sections).toHaveLength(1)
    expect(p.key).toBe('C')
    expect(p.meter).toBe('4/4')
    expect(p.grandStaff).toBe(false)
  })

  it('honors targetBars/grandStaff and clamps absurd lengths', () => {
    expect(fallbackPlan({ targetBars: 4, grandStaff: true }).sections[0].bars).toBe(4)
    expect(fallbackPlan({ targetBars: 9999 }).sections[0].bars).toBeLessThanOrEqual(32)
    expect(fallbackPlan({ grandStaff: true }).grandStaff).toBe(true)
  })
})
