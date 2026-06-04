import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Classification } from '@/lib/orchestrator/types'

const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {
      status?: number
      constructor(message: string, status?: number) {
        super(message)
        this.status = status
      }
    }
    static RateLimitError = class extends Error {}
  }
  return { default: MockAnthropic }
})

const { classify } = await import('@/lib/orchestrator/classifier')

function classifierResponse(input: Partial<Classification>): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_classifier_1',
        name: 'classify',
        input: {
          kind: 'generate_simple',
          scope: 'snippet',
          complexity: 'simple',
          confidence: 0.95,
          ...input,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 30 },
  }
}

describe('orchestrator/classifier', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
  })

  it('parses a valid Haiku tool_use into a Classification', async () => {
    anthropicCreateMock.mockResolvedValue(
      classifierResponse({ kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.9 }),
    )
    const result = await classify({ userText: 'a c major scale', editedScore: undefined, history: [] })
    expect(result.kind).toBe('generate_simple')
    expect(result.scope).toBe('snippet')
    expect(result.complexity).toBe('simple')
    expect(result.confidence).toBe(0.9)
  })

  it('uses the Haiku model id', async () => {
    anthropicCreateMock.mockResolvedValue(classifierResponse({}))
    await classify({ userText: 'x', editedScore: undefined, history: [] })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toMatch(/haiku/i)
  })

  it('sends a temperature of 0 (deterministic)', async () => {
    anthropicCreateMock.mockResolvedValue(classifierResponse({}))
    await classify({ userText: 'x', editedScore: undefined, history: [] })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.temperature).toBe(0)
  })

  it('forces tool_choice = classify', async () => {
    anthropicCreateMock.mockResolvedValue(classifierResponse({}))
    await classify({ userText: 'x', editedScore: undefined, history: [] })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.tool_choice).toMatchObject({ type: 'tool', name: 'classify' })
  })

  it('throws ClassifierSchemaError when the tool input fails schema validation', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_bad',
          name: 'classify',
          input: { kind: 'invalid_kind', scope: 'x', complexity: 'y', confidence: 'not_a_number' },
        },
      ],
    })
    const { ClassifierSchemaError } = await import('@/lib/orchestrator/classifier')
    await expect(classify({ userText: 'x', editedScore: undefined, history: [] })).rejects.toThrow(
      ClassifierSchemaError,
    )
  })

  it('throws ClassifierSchemaError when response has no tool_use block', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'I refuse to classify.' }],
    })
    const { ClassifierSchemaError } = await import('@/lib/orchestrator/classifier')
    await expect(classify({ userText: 'x', editedScore: undefined, history: [] })).rejects.toThrow(
      ClassifierSchemaError,
    )
  })

  it('caches system prompt and tool definition (cache_control: ephemeral)', async () => {
    anthropicCreateMock.mockResolvedValue(classifierResponse({}))
    await classify({ userText: 'x', editedScore: undefined, history: [] })
    const call = anthropicCreateMock.mock.calls[0][0]
    const systemBlocks = call.system
    expect(Array.isArray(systemBlocks)).toBe(true)
    expect(systemBlocks[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect(call.tools[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  it('passes user text as a single user-role message', async () => {
    anthropicCreateMock.mockResolvedValue(classifierResponse({}))
    await classify({ userText: 'change key to D', editedScore: undefined, history: [] })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0].role).toBe('user')
    const text = (call.messages[0].content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === 'text',
    )
    expect(text?.text).toContain('change key to D')
  })

  it('embeds editedScore JSON when provided', async () => {
    anthropicCreateMock.mockResolvedValue(classifierResponse({}))
    const editedScore = {
      title: 'edit',
      key: 'C' as const,
      meter: '4/4' as const,
      measures: [{ events: [{ pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const }] }],
    }
    await classify({ userText: 'transpose', editedScore, history: [] })
    const call = anthropicCreateMock.mock.calls[0][0]
    const text = (call.messages[0].content as Array<{ type: string; text?: string }>)
      .map((b) => b.text ?? '')
      .join(' ')
    expect(text).toContain('"key": "C"')
  })

  it('parses score_level_ops for edit_score_level classifications', async () => {
    anthropicCreateMock.mockResolvedValue(
      classifierResponse({
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
        score_level_ops: [{ kind: 'changeKey', key: 'G' }],
      } as Partial<Classification>),
    )
    const result = await classify({ userText: 'change key to G', editedScore: undefined, history: [] })
    expect(result.kind).toBe('edit_score_level')
    expect(result.score_level_ops).toEqual([{ kind: 'changeKey', key: 'G' }])
  })

  it('parses a changeClef score-level op (M25-PR-6 — previously fell through)', async () => {
    // The prompt instructed changeClef and editScoreLevel allowed it, but
    // the schema rejected it, so "switch to bass clef" always fell through.
    anthropicCreateMock.mockResolvedValue(
      classifierResponse({
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.97,
        score_level_ops: [{ kind: 'changeClef', clef: 'bass' }],
      } as Partial<Classification>),
    )
    const result = await classify({ userText: 'switch to bass clef', editedScore: undefined, history: [] })
    expect(result.kind).toBe('edit_score_level')
    expect(result.score_level_ops).toEqual([{ kind: 'changeClef', clef: 'bass' }])
  })
})
