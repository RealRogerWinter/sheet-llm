import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

// Mock the SDK: messages.create routes through a single spy we inspect.
const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {}
    static RateLimitError = class extends Error {}
    static APIUserAbortError = class extends Error {}
  }
  return { default: MockAnthropic }
})

const { AnthropicProvider } = await import('@/lib/providers/anthropic')
const { OutputTruncatedError } = await import('@/lib/providers/types')

function tool(name: string) {
  return {
    name,
    description: `desc-${name}`,
    inputSchema: z.object({ ok: z.boolean() }),
    inputSchemaJson: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    },
  }
}

const TOOLS = [tool('emit_a'), tool('emit_b')]

function lastBody(): Record<string, unknown> {
  return anthropicCreateMock.mock.calls.at(-1)![0] as Record<string, unknown>
}

describe('AnthropicProvider.multiToolCall', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
  })

  it('sends tool_choice:auto with ALL tool defs and caches the last tool', async () => {
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'emit_a', input: { ok: true } }],
      usage: { input_tokens: 100, output_tokens: 20 },
    })
    const provider = new AnthropicProvider()
    await provider.multiToolCall(TOOLS, {
      systemPrompt: 's',
      userText: 'u',
      modelOverride: 'claude-haiku-4-5',
      providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
    })
    const body = lastBody()
    expect(body.tool_choice).toEqual({ type: 'auto' })
    const tools = body.tools as Array<{ name: string; cache_control?: unknown }>
    expect(tools.map((t) => t.name)).toEqual(['emit_a', 'emit_b'])
    // Only the LAST tool carries the cache breakpoint (caches the whole prefix).
    expect(tools[0].cache_control).toBeUndefined()
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('returns the tool branch (raw input, id, model, usage) when the model calls a tool', async () => {
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tool-xyz', name: 'emit_b', input: { ok: false, extra: 1 } },
      ],
      usage: { input_tokens: 80, cache_read_input_tokens: 40, output_tokens: 12 },
    })
    const provider = new AnthropicProvider()
    const res = await provider.multiToolCall(TOOLS, {
      systemPrompt: 's',
      userText: 'u',
      modelOverride: 'claude-haiku-4-5',
    })
    expect(res.kind).toBe('tool')
    if (res.kind !== 'tool') throw new Error('expected tool branch')
    expect(res.name).toBe('emit_b')
    // RAW, unvalidated input is passed through (caller owns the zod parse).
    expect(res.input).toEqual({ ok: false, extra: 1 })
    expect(res.toolUseId).toBe('tool-xyz')
    expect(res.model).toBe('claude-haiku-4-5')
    expect(res.usage).toEqual({ inputTokens: 80, cachedInputTokens: 40, outputTokens: 12 })
  })

  it('returns the text branch (concatenated text) when the model replies in prose', async () => {
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'This is in ' },
        { type: 'text', text: 'C major.' },
      ],
      usage: { input_tokens: 50, output_tokens: 8 },
    })
    const provider = new AnthropicProvider()
    const res = await provider.multiToolCall(TOOLS, {
      systemPrompt: 's',
      userText: 'what key?',
      modelOverride: 'claude-haiku-4-5',
    })
    expect(res.kind).toBe('text')
    if (res.kind !== 'text') throw new Error('expected text branch')
    expect(res.text).toBe('This is in C major.')
    expect(res.model).toBe('claude-haiku-4-5')
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 8 })
  })

  it('throws OutputTruncatedError when the response hit max_tokens', async () => {
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [],
      usage: { input_tokens: 100, output_tokens: 8000 },
    })
    const provider = new AnthropicProvider()
    await expect(
      provider.multiToolCall(TOOLS, {
        systemPrompt: 's',
        userText: 'u',
        maxTokens: 8000,
        modelOverride: 'claude-haiku-4-5',
      }),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
  })
})
