import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

/**
 * Cost-regression suite. Asserts which model id each orchestrator
 * path invokes — protects against accidental Sonnet/Opus usage on
 * the classifier path or stray Haiku calls on a generation path.
 *
 * Runs with the @anthropic-ai/sdk fully mocked. ZERO API spend.
 */

const VALID_SCORE: Score = {
  title: 'OK',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
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

describe('cost regression — model id per orchestrator path', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('classifier uses ONLY Haiku, never Sonnet or Opus', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'classify',
          input: { kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.9 },
        },
      ],
    })
    const { _resetClassifierClient, classify } = await import('@/lib/orchestrator/classifier')
    _resetClassifierClient()
    await classify({ userText: 'x', editedScore: undefined, history: [] })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    const model = anthropicCreateMock.mock.calls[0][0].model as string
    expect(model).toMatch(/haiku/i)
    expect(model).not.toMatch(/sonnet/i)
    expect(model).not.toMatch(/opus/i)
  })

  it('editIntraMeasure uses ONLY Sonnet, never Opus', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'edit_score',
          input: { ops: [{ kind: 'setAccidental', target: { measureIdx: 0, eventIdx: 0 }, accidental: 'sharp' }] },
        },
      ],
    })
    const { _resetIntraMeasureClient, runEditIntraMeasure } = await import(
      '@/lib/orchestrator/handlers/editIntraMeasure'
    )
    _resetIntraMeasureClient()
    await runEditIntraMeasure({
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
        target_description: 'x',
      },
      editedScore: VALID_SCORE,
    })
    const model = anthropicCreateMock.mock.calls[0][0].model as string
    expect(model).toMatch(/sonnet/i)
    expect(model).not.toMatch(/opus/i)
  })

  it('generateComplex uses ONLY Sonnet, never Opus or Haiku (no-Opus directive)', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'render_score', input: VALID_SCORE }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    const { _resetGenerateComplexClient, runGenerateComplex } = await import(
      '@/lib/orchestrator/handlers/generateComplex'
    )
    _resetGenerateComplexClient()
    await runGenerateComplex({
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-cr-1',
      userText: 'test prompt',
    })
    const model = anthropicCreateMock.mock.calls[0][0].model as string
    expect(model).toMatch(/sonnet/i)
    expect(model).not.toMatch(/opus/i)
    expect(model).not.toMatch(/haiku/i)
  })

  it('compose uses ONLY Sonnet, never Opus — even with budget headroom (no-Opus directive)', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'render_score', input: VALID_SCORE }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    const { _resetComposeClient, runCompose } = await import(
      '@/lib/orchestrator/handlers/compose'
    )
    const { _resetBudget } = await import('@/lib/orchestrator/budget')
    _resetComposeClient()
    _resetBudget()
    await runCompose({
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      chatId: 'chat-compose-cr',
      userText: 'test prompt',
      editedScore: VALID_SCORE,
    })
    // Fresh budget (headroom) — compose no longer reaches for Opus.
    const model = (anthropicCreateMock.mock.calls[0][0] as { model: string }).model
    expect(model).toMatch(/sonnet/i)
    expect(model).not.toMatch(/opus/i)
  })

  it('refuse handler makes ZERO LLM calls', async () => {
    const { runRefuse } = await import('@/lib/orchestrator/handlers/refuse')
    runRefuse({
      classification: {
        kind: 'refuse',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 1,
        reason: 'no',
      },
      refusalCode: 'copyright',
    })
    expect(anthropicCreateMock).not.toHaveBeenCalled()
  })

  it('editScoreLevel handler makes ZERO LLM calls', async () => {
    const { runEditScoreLevel } = await import('@/lib/orchestrator/handlers/editScoreLevel')
    await runEditScoreLevel({
      classification: {
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 1,
        score_level_ops: [{ kind: 'changeKey', key: 'G' }],
      },
      editedScore: VALID_SCORE,
    })
    expect(anthropicCreateMock).not.toHaveBeenCalled()
  })
})

describe('cost regression — classifier model id is pinned with date suffix', () => {
  it('pins claude-haiku-4-5-* exactly', async () => {
    // Read the source to be defensive against module memoization
    // across re-import. The presence of the dated suffix in the
    // model constant is the contract we're locking.
    anthropicCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'classify',
          input: { kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.9 },
        },
      ],
    })
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const { _resetClassifierClient, classify } = await import('@/lib/orchestrator/classifier')
    _resetClassifierClient()
    await classify({ userText: 'x', editedScore: undefined, history: [] })
    const model = anthropicCreateMock.mock.calls[0][0].model as string
    expect(model).toMatch(/^claude-haiku-4-5-\d+$/)
  })
})
