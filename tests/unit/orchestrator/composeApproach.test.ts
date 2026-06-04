import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const BASE_SCORE: Score = {
  title: 'Base',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
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

const { classifyComposeApproach } = await import(
  '@/lib/orchestrator/composeApproach'
)

function approachResponse(decision: 'patch' | 'regen'): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_approach_1',
        name: 'classify_compose_approach',
        input: { decision },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 5 },
  }
}

describe('orchestrator/composeApproach', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it("returns 'patch' when the sub-classifier emits decision: patch", async () => {
    anthropicCreateMock.mockResolvedValue(approachResponse('patch'))
    const result = await classifyComposeApproach({
      userText: 'raise the third note an octave',
      editedScore: BASE_SCORE,
      chatId: 'chat-1',
    })
    expect(result).toBe('patch')
  })

  it("returns 'regen' when the sub-classifier emits decision: regen", async () => {
    anthropicCreateMock.mockResolvedValue(approachResponse('regen'))
    const result = await classifyComposeApproach({
      userText: 'add a bass line counterpoint',
      editedScore: BASE_SCORE,
      chatId: 'chat-2',
    })
    expect(result).toBe('regen')
  })

  it('uses the small tier (Haiku) so the call stays cheap', async () => {
    anthropicCreateMock.mockResolvedValue(approachResponse('patch'))
    await classifyComposeApproach({
      userText: 'test',
      editedScore: BASE_SCORE,
      chatId: 'chat-tier',
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.model).toMatch(/haiku/i)
  })

  it('forces the classify_compose_approach tool', async () => {
    anthropicCreateMock.mockResolvedValue(approachResponse('patch'))
    await classifyComposeApproach({
      userText: 'test',
      editedScore: BASE_SCORE,
      chatId: 'chat-tool',
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.tool_choice).toMatchObject({ type: 'tool', name: 'classify_compose_approach' })
    expect(call.tools[0].name).toBe('classify_compose_approach')
    expect(call.tools[0].input_schema.properties.decision.enum).toEqual(['patch', 'regen'])
  })

  it('keeps the prompt cheap by sending a 1-line score summary, not the full JSON', async () => {
    anthropicCreateMock.mockResolvedValue(approachResponse('regen'))
    await classifyComposeApproach({
      userText: 'do something',
      editedScore: BASE_SCORE,
      chatId: 'chat-prompt',
    })
    const call = anthropicCreateMock.mock.calls[0][0]
    const userMessage = call.messages.find((m: { role: string }) => m.role === 'user')
    const userText: string = userMessage.content[0].text
    // The summary line should appear; the full score JSON should NOT.
    expect(userText).toContain('1 measures, key=C, meter=4/4')
    expect(userText).not.toContain('"pitches"')
  })

  it("defaults to 'regen' when the provider throws (conservative fallback)", async () => {
    anthropicCreateMock.mockRejectedValue(new Error('provider down'))
    const result = await classifyComposeApproach({
      userText: 'anything',
      editedScore: BASE_SCORE,
      chatId: 'chat-fail',
    })
    expect(result).toBe('regen')
  })

  it("defaults to 'regen' when the tool returns a malformed decision", async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'classify_compose_approach',
          input: { decision: 'maybe' },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 5 },
    })
    const result = await classifyComposeApproach({
      userText: 'anything',
      editedScore: BASE_SCORE,
      chatId: 'chat-malformed',
    })
    expect(result).toBe('regen')
  })
})
