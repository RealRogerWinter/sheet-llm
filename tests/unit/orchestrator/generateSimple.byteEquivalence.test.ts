import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Anthropic SDK and capture the exact request body the provider
// sends, so we can assert byte-equivalence with the legacy realClient path.
const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class APIError extends Error {
      status?: number
      constructor(message: string, status?: number) {
        super(message)
        this.status = status
      }
    }
    static RateLimitError = class RateLimitError extends Error {}
    static APIUserAbortError = class APIUserAbortError extends Error {}
  }
  return { default: MockAnthropic }
})

const { runGenerateSimple } = await import('@/lib/orchestrator/handlers/generateSimple')
const { renderScoreTool } = await import('@/lib/llm/renderScoreTool')
const { SYSTEM_PROMPT } = await import('@/lib/llm/systemPrompt')
const { clearStickyForChat } = await import('@/lib/providers/sticky')

describe('runGenerateSimple — byte-equivalence with the legacy realClient request', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('PROVIDER_MEDIUM', 'anthropic') // default-tier provider for generate_simple
  })

  it('sends the correct Anthropic request with Haiku for simple complexity (SHE-19)', async () => {
    const chatId = `chat-${'be-1'}`
    clearStickyForChat(chatId)

    // Capture the request, then bail (we only assert the request shape).
    let captured: Record<string, unknown> | undefined
    anthropicCreateMock.mockImplementation((body: Record<string, unknown>) => {
      captured = body
      throw new Error('STOP_AFTER_CAPTURE')
    })

    const history = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'compose a short fugue subject in D minor' }] },
    ]

    await expect(
      runGenerateSimple({
        classification: { kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.9 },
        history,
        chatId,
      }),
    ).rejects.toBeTruthy()

    // SHE-19: simple complexity → small tier (Haiku). Only the model id changed from the
    // legacy Sonnet path; system prompt / tool / cache_control are byte-identical.
    const legacyEquivalent = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8_000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'render_score',
          description: renderScoreTool.description,
          input_schema: renderScoreTool.input_schema,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tool_choice: { type: 'tool', name: 'render_score' },
      messages: history,
    }

    expect(captured).toEqual(legacyEquivalent)
  })

  it('respects modelOverride (routes the same request to the chosen model)', async () => {
    const chatId = `chat-${'be-2'}`
    clearStickyForChat(chatId)
    let captured: Record<string, unknown> | undefined
    anthropicCreateMock.mockImplementation((body: Record<string, unknown>) => {
      captured = body
      throw new Error('STOP')
    })
    await expect(
      runGenerateSimple({
        classification: { kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.9 },
        history: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
        chatId,
        modelOverride: 'claude-opus-4-7',
      }),
    ).rejects.toBeTruthy()
    expect(captured?.model).toBe('claude-opus-4-7')
  })
})
