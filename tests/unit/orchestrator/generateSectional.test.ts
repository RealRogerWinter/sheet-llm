import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CLASSIFY_TOOL_NAME } from '@/lib/orchestrator/classifierPrompt'
import { isOrchestratorScoreStream } from '@/lib/orchestrator/types'
import type { ScoreStreamEvent } from '@/lib/orchestrator/types'

// Shared Anthropic SDK stub: every provider call (plan / seed / extend /
// classifier) routes through this. We sequence responses per call.
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

const { runGenerateSectional } = await import('@/lib/orchestrator/handlers/generateSectional')
const { run } = await import('@/lib/orchestrator/index')

// ── Fixtures ──────────────────────────────────────────────────────────
const wholeBar = () => ({ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] })
const SEED_SCORE = {
  key: 'C',
  meter: '4/4',
  measures: Array.from({ length: 8 }, wholeBar),
}
const PLAN_INPUT = {
  key: 'C',
  meter: '4/4',
  grandStaff: false,
  sections: [
    { label: 'A', bars: 4, hint: 'opening theme' },
    { label: 'B', bars: 4, hint: 'continuation' },
  ],
}

function toolResp(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
    usage: { input_tokens: 100, output_tokens: 200 },
  }
}

function classifierResp(kind: string): unknown {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_classify',
        name: CLASSIFY_TOOL_NAME,
        input: { kind, scope: 'long', complexity: 'complex', confidence: 0.95 },
      },
    ],
    usage: { input_tokens: 120, output_tokens: 40 },
  }
}

// plan -> seed (render_score) -> extend (emit_appended_bars)
function queueSectionalCalls() {
  anthropicCreateMock
    .mockResolvedValueOnce(toolResp('emit_score_plan', PLAN_INPUT))
    .mockResolvedValueOnce(toolResp('render_score', SEED_SCORE))
    .mockResolvedValueOnce(toolResp('emit_appended_bars', { measures: Array.from({ length: 4 }, wholeBar) }))
}

const CLASSIFICATION = {
  kind: 'generate_complex' as const,
  scope: 'long' as const,
  complexity: 'complex' as const,
  confidence: 0.95,
}

describe('runGenerateSectional (M25-PR-3 handler)', () => {
  beforeEach(async () => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    const { _resetBudget } = await import('@/lib/orchestrator/budget')
    _resetBudget()
  })

  it('assembles a seed section + an extended section into one score', async () => {
    queueSectionalCalls()
    const result = await runGenerateSectional({
      classification: CLASSIFICATION,
      chatId: 'c-sectional',
      userText: 'a 12-bar piece with an A and B section',
    })
    // 8 seed bars + 4 extended bars = 12.
    expect(result.score.measures).toHaveLength(12)
    expect(result.score.key).toBe('C')
    expect(result.introText).toContain('12-bar')
    expect(result.introText).toContain('2 sections')
    // plan + seed + extend = 3 bounded calls (none of them the whole piece).
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3)
    // Each generation call stayed bounded — no single 25k-token request.
    for (const call of anthropicCreateMock.mock.calls) {
      expect(call[0].max_tokens).toBeLessThanOrEqual(8000)
    }
  })

  it('returns the partial score (with a warning) when a later section fails', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(toolResp('emit_score_plan', PLAN_INPUT))
      .mockResolvedValueOnce(toolResp('render_score', SEED_SCORE))
      // The extend call returns a tool with the WRONG name -> the provider
      // throws ProviderSchemaError -> runExtendComposition wraps it in
      // ExtendCompositionError -> sectional keeps the seed and warns.
      .mockResolvedValue(toolResp('wrong_tool', {}))
    const result = await runGenerateSectional({
      classification: CLASSIFICATION,
      chatId: 'c-partial',
      userText: 'a 12-bar piece',
    })
    expect(result.score.measures).toHaveLength(8) // only the seed survived
    expect(result.warnings?.some((w) => /Stopped after 1 section/.test(w))).toBe(true)
  })

  it('adaptively splits a chunk that truncates and recovers (no fatal error)', async () => {
    // The opening chunk is too dense for the token budget and truncates;
    // the generator must HALVE it and retry the smaller pieces rather than
    // failing with "section too dense" (the production bug being fixed).
    const twoBar = { key: 'C', meter: '4/4', measures: Array.from({ length: 2 }, wholeBar) }
    anthropicCreateMock
      .mockResolvedValueOnce(
        toolResp('emit_score_plan', {
          key: 'C',
          meter: '4/4',
          grandStaff: false,
          sections: [{ label: 'A', bars: 4, hint: 'very dense' }],
        }),
      )
      // seed (4 bars) hits the max_tokens ceiling -> OutputTruncatedError
      .mockResolvedValueOnce({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', id: 'tt', name: 'render_score', input: {} }],
        usage: { output_tokens: 8000 },
      })
      // retry seed at 2 bars succeeds, remaining 2 bars extend
      .mockResolvedValueOnce(toolResp('render_score', twoBar))
      .mockResolvedValueOnce(toolResp('emit_appended_bars', { measures: Array.from({ length: 2 }, wholeBar) }))

    const result = await runGenerateSectional({
      classification: CLASSIFICATION,
      chatId: 'c-split',
      userText: 'a dense 4-bar piece',
    })
    // 2 (split-seed) + 2 (split-remainder) = 4 bars; recovered, did not throw.
    expect(result.score.measures).toHaveLength(4)
    // plan + truncated-seed + retry-seed + extend = 4 calls (split added one).
    expect(anthropicCreateMock).toHaveBeenCalledTimes(4)
  })

  it('adaptively splits a chunk that fails validation and recovers', async () => {
    // The model can't make a 2-bar chunk rhythmically valid (each bar sums
    // wrong); after one feedback retry the generator HALVES it and the
    // 1-bar pieces validate — instead of the "duration sum" dead-end.
    const invalidTwoBar = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] },
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] },
      ],
    }
    const validOneBar = { key: 'C', meter: '4/4', measures: [wholeBar()] }
    anthropicCreateMock
      .mockResolvedValueOnce(
        toolResp('emit_score_plan', {
          key: 'C',
          meter: '4/4',
          grandStaff: false,
          sections: [{ label: 'A', bars: 2, hint: 'dense' }],
        }),
      )
      // 2-bar seed: two attempts (original + 1 feedback retry), both invalid
      .mockResolvedValueOnce(toolResp('render_score', invalidTwoBar))
      .mockResolvedValueOnce(toolResp('render_score', invalidTwoBar))
      // after the split: the 1-bar seed validates, then 1 bar extends
      .mockResolvedValueOnce(toolResp('render_score', validOneBar))
      .mockResolvedValueOnce(toolResp('emit_appended_bars', { measures: [wholeBar()] }))

    const result = await runGenerateSectional({
      classification: CLASSIFICATION,
      chatId: 'c-vsplit',
      userText: 'a dense 2-bar piece',
    })
    // 1 (split-seed) + 1 (split-remainder) = 2 bars; recovered, did not throw.
    expect(result.score.measures).toHaveLength(2)
    // plan + 2 invalid 2-bar attempts + valid 1-bar seed + 1-bar extend = 5.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(5)
  })
})

describe('orchestrator wiring: generate_complex -> sectional (M25-PR-3)', () => {
  beforeEach(async () => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('SL_SECTIONAL_GEN', '1')
    // Sectional is a PRO-tier path — PR-13 clamps the free tier to single-shot
    // even with the bounded handler off (allowSectional is enforced) — so the run
    // below sets generationTier:'pro' to reach the sectional pipeline.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    const { _resetBudget } = await import('@/lib/orchestrator/budget')
    _resetBudget()
  })

  it('a fresh generate_complex request streams a section-by-section assembly', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(classifierResp('generate_complex')) // classifier
      .mockResolvedValueOnce(toolResp('emit_score_plan', PLAN_INPUT)) // plan
      .mockResolvedValueOnce(toolResp('render_score', SEED_SCORE)) // seed
      .mockResolvedValueOnce(toolResp('emit_appended_bars', { measures: Array.from({ length: 4 }, wholeBar) })) // extend

    const outcome = await run({
      requestId: 'req-sectional',
      chatId: 'chat-sectional',
      userText: 'a 12-bar piece in two sections',
      history: [],
      generationTier: 'pro',
    })

    // The orchestrator returns a streaming outcome; the generator runs
    // lazily as we drain it (so plan/seed/extend fire here).
    expect(isOrchestratorScoreStream(outcome)).toBe(true)
    if (!isOrchestratorScoreStream(outcome)) throw new Error('expected a score stream')
    expect(outcome.classification.kind).toBe('generate_complex')

    const events: ScoreStreamEvent[] = []
    for await (const ev of outcome.events) events.push(ev)

    const sections = events.filter((e) => e.type === 'section')
    const done = events.find((e) => e.type === 'done')
    expect(sections.length).toBe(2) // seed + one extend
    expect(done && done.type === 'done' ? done.score.measures.length : 0).toBe(12)
    // classifier + plan + seed + extend = 4 calls.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(4)
  })
})
