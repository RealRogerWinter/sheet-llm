import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class APIError extends Error {
      status?: number
      constructor(message: string, status?: number) { super(message); this.status = status }
    }
    static RateLimitError = class RateLimitError extends Error {}
    // M26 PR-2: the provider's catches reference APIUserAbortError (it must
    // precede the generic APIError branch); the mock needs it defined or the
    // `instanceof` throws on undefined.
    static APIUserAbortError = class APIUserAbortError extends Error {}
  }
  return { default: MockAnthropic }
})

const { AnthropicProvider, mapAnthropicUsage } = await import('@/lib/providers/anthropic')
const { ProviderSchemaError } = await import('@/lib/providers/types')

const SimpleSchema = z.object({ x: z.string(), y: z.number() })

function toolUseResponse(input: unknown, opts: { id?: string; introText?: string; usage?: unknown } = {}) {
  const content: unknown[] = []
  if (opts.introText) content.push({ type: 'text', text: opts.introText })
  content.push({ type: 'tool_use', id: opts.id ?? 'toolu_test_1', name: 'test_tool', input })
  return {
    content,
    usage: opts.usage ?? { input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 25 },
  }
}

describe('AnthropicProvider', () => {
  let provider: InstanceType<typeof AnthropicProvider>

  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    provider = new AnthropicProvider()
  })

  it('returns the parsed tool input on success', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 42 }))
    const r = await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(r.input).toEqual({ x: 'hi', y: 42 })
    expect(r.toolUseId).toBe('toolu_test_1')
    expect(r.model).toBe('claude-sonnet-4-6')
    expect(r.usage?.inputTokens).toBe(100)
    expect(r.usage?.cachedInputTokens).toBe(80)
    expect(r.usage?.outputTokens).toBe(25)
  })

  it('captures cache_creation_input_tokens (cache-write) from the response usage', async () => {
    anthropicCreateMock.mockResolvedValue(
      toolUseResponse(
        { x: 'hi', y: 1 },
        { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000, output_tokens: 7 } },
      ),
    )
    const r = await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(r.usage?.cacheCreationInputTokens).toBe(5000)
    expect(r.usage?.inputTokens).toBe(10)
    expect(r.usage?.outputTokens).toBe(7)
  })

  it('throws ProviderSchemaError when the tool input fails zod validation', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 'not-a-number' }))
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(ProviderSchemaError)
  })

  it('throws ProviderSchemaError when no tool_use block is returned (treated as a schema-level miss)', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'I refuse.' }],
    })
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(ProviderSchemaError)
  })

  it('applies cache_control: ephemeral on system + tool by default', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.system[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect(call.tools[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  it('emits multi-block system layout with per-block cache markers', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      {
        systemPrompt: [
          { text: 'role: you are a tester' },
          { text: 'shared reference body', cache: true },
          { text: 'constraints: be brief' },
        ],
        userText: 'usr',
        toolChoice: 'required',
      },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.system).toHaveLength(3)
    expect(call.system[0]).toMatchObject({ type: 'text', text: 'role: you are a tester' })
    expect(call.system[0].cache_control).toBeUndefined()
    expect(call.system[1]).toMatchObject({
      type: 'text',
      text: 'shared reference body',
      cache_control: { type: 'ephemeral' },
    })
    expect(call.system[2]).toMatchObject({ type: 'text', text: 'constraints: be brief' })
    expect(call.system[2].cache_control).toBeUndefined()
  })

  it('honors multiple cache markers up to the per-request budget', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      {
        systemPrompt: [
          { text: 'a', cache: true },
          { text: 'b', cache: true },
          { text: 'c', cache: true },
        ],
        userText: 'usr',
        toolChoice: 'required',
      },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    const cached = call.system.filter((b: { cache_control?: unknown }) => b.cache_control)
    expect(cached).toHaveLength(3)
  })

  it('drops cache markers entirely when cacheControl: "none"', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      {
        systemPrompt: [
          { text: 'a', cache: true },
          { text: 'b', cache: true },
        ],
        userText: 'usr',
        toolChoice: 'required',
        providerOptions: { anthropic: { cacheControl: 'none' } },
      },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.system).toHaveLength(2)
    for (const block of call.system) expect(block.cache_control).toBeUndefined()
  })

  it('omits cache_control when providerOptions.anthropic.cacheControl is "none"', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      {
        systemPrompt: 'sys',
        userText: 'usr',
        toolChoice: 'required',
        providerOptions: { anthropic: { cacheControl: 'none' } },
      },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.system[0].cache_control).toBeUndefined()
    expect(call.tools[0].cache_control).toBeUndefined()
  })

  it('honors modelOverride', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required', modelOverride: 'claude-haiku-4-5-20251001' },
    )
    expect(anthropicCreateMock.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001')
  })

  it('forces tool_choice', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.tool_choice).toMatchObject({ type: 'tool', name: 'test_tool' })
  })

  it('uses history when provided (multi-turn) instead of building from userText', async () => {
    anthropicCreateMock.mockResolvedValue(toolUseResponse({ x: 'hi', y: 1 }))
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      {
        systemPrompt: 'sys',
        toolChoice: 'required',
        history: [
          { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
          { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
        ],
      },
    )
    const call = anthropicCreateMock.mock.calls[0][0]
    expect(call.messages).toHaveLength(3)
    expect(call.messages[2].content[0]).toEqual({ type: 'text', text: 'turn 2' })
  })

  it('maps Anthropic.RateLimitError to RateLimitedError', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default as unknown as {
      RateLimitError: new (message: string) => Error
    }
    anthropicCreateMock.mockRejectedValue(new Anthropic.RateLimitError('429'))
    const { RateLimitedError } = await import('@/lib/llm/errors')
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(RateLimitedError)
  })

  it('maps Anthropic.APIError to UpstreamError with the API status', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default as unknown as {
      APIError: new (message: string, status: number) => Error
    }
    anthropicCreateMock.mockRejectedValue(new Anthropic.APIError('502 bad gateway', 502))
    const { UpstreamError } = await import('@/lib/llm/errors')
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(UpstreamError)
  })
})

describe('mapAnthropicUsage', () => {
  it('maps all four buckets, including cache_creation (cache-write)', () => {
    expect(
      mapAnthropicUsage({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 200,
        output_tokens: 30,
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 200,
      outputTokens: 30,
    })
  })

  it('preserves a 0 cache-write bucket (warm-cache call, not an absent field)', () => {
    expect(
      mapAnthropicUsage({ input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 5 })
        ?.cacheCreationInputTokens,
    ).toBe(0)
  })

  it('returns undefined when usage is absent', () => {
    expect(mapAnthropicUsage(undefined)).toBeUndefined()
    expect(mapAnthropicUsage(null)).toBeUndefined()
  })

  it('omits null / undefined fields rather than emitting them', () => {
    const u = mapAnthropicUsage({ input_tokens: 10, cache_read_input_tokens: null, output_tokens: 5 })
    expect(u).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(u && 'cachedInputTokens' in u).toBe(false)
  })
})
