import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const VALID_SCORE: Score = {
  title: 'OK',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

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

const { runGenerateComplex, _resetGenerateComplexClient } = await import(
  '@/lib/orchestrator/handlers/generateComplex'
)
const { runCompose, _resetComposeClient } = await import(
  '@/lib/orchestrator/handlers/compose'
)

function toolResponse(score: Score): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_x',
        name: 'render_score',
        input: score,
      },
    ],
    usage: { input_tokens: 500, output_tokens: 800 },
  }
}

describe('orchestrator/handlers/generateComplex', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    _resetGenerateComplexClient()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('uses a Sonnet model (no Opus)', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-1',
      userText: 'test prompt',
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toMatch(/sonnet/i)
    expect(call.model).not.toMatch(/opus/i)
  })

  it('uses higher max_tokens than the simple handler', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-1',
      userText: 'test prompt',
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.max_tokens).toBeGreaterThanOrEqual(4000)
  })

  it('returns the rendered Score', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    const result = await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-1',
      userText: 'test prompt',
    })
    expect(result.score).toEqual(VALID_SCORE)
    expect(result.model).toMatch(/sonnet/i)
  })

  it('records token usage against the chat budget', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    const { _resetBudget, getSessionUsage } = await import('@/lib/orchestrator/budget')
    _resetBudget()
    await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-1',
      userText: 'test prompt',
    })
    expect(getSessionUsage('chat-1')).toEqual({ inputTokens: 500, outputTokens: 800 })
  })
})

describe('orchestrator/handlers/compose', () => {
  beforeEach(async () => {
    anthropicCreateMock.mockReset()
    _resetComposeClient()
    const { _resetBudget } = await import('@/lib/orchestrator/budget')
    _resetBudget()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('uses a Sonnet model, never Opus', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    await runCompose({
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-1',
      userText: 'test prompt',
      editedScore: VALID_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toMatch(/sonnet/i)
    expect(call.model).not.toMatch(/opus/i)
  })

  it('stays on Sonnet when the budget is exhausted (no Opus path remains)', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    const { _setBudgetCap, recordUsage } = await import('@/lib/orchestrator/budget')
    _setBudgetCap({ inputTokens: 100, outputTokens: 100 })
    recordUsage('chat-budget-blown', 200, 0)
    await runCompose({
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-budget-blown',
      userText: 'test prompt',
      editedScore: VALID_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toMatch(/sonnet/i)
  })

  it('system prompt includes the copyright-safety clause', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    await runCompose({
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-1',
      userText: 'test prompt',
      editedScore: VALID_SCORE,
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const systemText =
      (call.system as Array<{ text?: string }> | undefined)
        ?.map((b) => b.text ?? '')
        .join(' ') ?? ''
    expect(systemText.toLowerCase()).toContain('copyright')
  })

  it('records token usage against the chat budget', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(VALID_SCORE))
    await runCompose({
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-2',
      userText: 'test prompt',
      editedScore: VALID_SCORE,
    })
    const { getSessionUsage } = await import('@/lib/orchestrator/budget')
    expect(getSessionUsage('chat-2')).toEqual({ inputTokens: 500, outputTokens: 800 })
  })
})

describe('orchestrator/handlers/scoreRetry (semantic-validation retry)', () => {
  // A measure that sums to 12 eighths but is stamped 4/4 — same shape
  // as the Opus failure that prompted adding the retry layer.
  const INVALID_SCORE: Score = {
    title: 'bad',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
        ],
      },
    ],
  }

  beforeEach(() => {
    anthropicCreateMock.mockReset()
    _resetGenerateComplexClient()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('retries on ValidationError and succeeds on the corrected response', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(toolResponse(INVALID_SCORE))
      .mockResolvedValueOnce(toolResponse(VALID_SCORE))

    const result = await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-retry-ok',
      userText: 'generate something',
    })

    expect(result.score).toEqual(VALID_SCORE)
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)

    // Retry call must feed the failed attempt back to the model via
    // history (assistant tool_use + user tool_result with is_error).
    const retryCall = anthropicCreateMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content: Array<{ type: string; is_error?: boolean }> }>
    }
    expect(retryCall.messages.length).toBeGreaterThanOrEqual(3)
    const lastTurn = retryCall.messages[retryCall.messages.length - 1]
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.content[0].type).toBe('tool_result')
    expect(lastTurn.content[0].is_error).toBe(true)
  })

  it('throws after exhausting retries (default 2)', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse(INVALID_SCORE))

    await expect(
      runGenerateComplex({
        classification: {
          kind: 'generate_complex',
          scope: 'long',
          complexity: 'complex',
          confidence: 0.9,
        },
        chatId: 'chat-retry-exhausted',
        userText: 'generate something',
      }),
    ).rejects.toThrow(/duration sum|measure_duration_mismatch/i)

    // 1 initial + 2 retries = 3 calls total.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3)
  })

  it('backfills missing ids on LLM-emitted techniqueStates (M3-PR-1)', async () => {
    // The LLM emits techniqueStates without ids; scoreRetry calls
    // ensureTechniqueIds on success so downstream edit-op handlers
    // can resolve changes by id.
    const SCORE_WITH_ID_LESS_TECHNIQUES = {
      ...VALID_SCORE,
      techniqueStates: [
        { measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' as const },
      ],
    }
    anthropicCreateMock.mockResolvedValue(toolResponse(SCORE_WITH_ID_LESS_TECHNIQUES))

    const result = await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-tech-backfill',
      userText: 'cello pizz line',
    })

    expect(result.score.techniqueStates).toHaveLength(1)
    expect(result.score.techniqueStates![0].id).toBeDefined()
    expect(typeof result.score.techniqueStates![0].id).toBe('string')
    expect(result.score.techniqueStates![0].id!.length).toBeGreaterThanOrEqual(8)
  })
})
