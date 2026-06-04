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
  }
  return { default: MockAnthropic }
})

const { AnthropicProvider } = await import('@/lib/providers/anthropic')

const TOOL = {
  name: 'mytool',
  description: 'd',
  inputSchema: z.object({ ok: z.boolean() }),
  inputSchemaJson: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
}

function lastBody(): Record<string, unknown> {
  return anthropicCreateMock.mock.calls.at(-1)![0] as Record<string, unknown>
}

async function callWith(opts: Record<string, unknown>) {
  const provider = new AnthropicProvider()
  await provider.toolCall(TOOL, {
    systemPrompt: 's',
    userText: 'u',
    ...opts,
  } as Parameters<typeof provider.toolCall>[1])
  return lastBody()
}

describe('AnthropicProvider — per-model tuning', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'mytool', input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
  })

  it('drops temperature on Opus 4.7/4.8 but keeps it on Sonnet 4.6 and Haiku 4.5', async () => {
    expect((await callWith({ temperature: 0, modelOverride: 'claude-opus-4-7' })).temperature).toBeUndefined()
    expect((await callWith({ temperature: 0, modelOverride: 'claude-opus-4-8' })).temperature).toBeUndefined()
    expect((await callWith({ temperature: 0, modelOverride: 'claude-sonnet-4-6' })).temperature).toBe(0)
    expect((await callWith({ temperature: 0, modelOverride: 'claude-haiku-4-5' })).temperature).toBe(0)
    // Opus 4.6 still accepts sampling params.
    expect((await callWith({ temperature: 0, modelOverride: 'claude-opus-4-6' })).temperature).toBe(0)
  })

  it('forwards effort only to models that support it', async () => {
    expect((await callWith({ effort: 'low', modelOverride: 'claude-sonnet-4-6' })).output_config).toEqual({
      effort: 'low',
    })
    // Haiku 4.5 and Sonnet 4.5 reject effort -> dropped.
    expect((await callWith({ effort: 'low', modelOverride: 'claude-haiku-4-5' })).output_config).toBeUndefined()
    expect((await callWith({ effort: 'low', modelOverride: 'claude-sonnet-4-5' })).output_config).toBeUndefined()
  })

  it('passes thinking disabled / adaptive through', async () => {
    expect((await callWith({ thinking: 'disabled', modelOverride: 'claude-sonnet-4-6' })).thinking).toEqual({
      type: 'disabled',
    })
    expect((await callWith({ thinking: 'adaptive', modelOverride: 'claude-sonnet-4-6' })).thinking).toEqual({
      type: 'adaptive',
    })
    // Unset -> no thinking field (model default).
    expect((await callWith({ modelOverride: 'claude-sonnet-4-6' })).thinking).toBeUndefined()
  })

  it('defaults max_tokens to 8000 and honors an explicit value', async () => {
    expect((await callWith({ modelOverride: 'claude-sonnet-4-6' })).max_tokens).toBe(8000)
    expect((await callWith({ maxTokens: 300, modelOverride: 'claude-sonnet-4-6' })).max_tokens).toBe(300)
  })

  it('forwards strict into the tool definition only when set', async () => {
    const provider = new AnthropicProvider()
    await provider.toolCall(
      { ...TOOL, strict: true },
      { systemPrompt: 's', userText: 'u', modelOverride: 'claude-sonnet-4-6' },
    )
    const tools = lastBody().tools as Array<{ strict?: boolean }>
    expect(tools[0].strict).toBe(true)

    const without = await callWith({ modelOverride: 'claude-sonnet-4-6' })
    expect((without.tools as Array<{ strict?: boolean }>)[0].strict).toBeUndefined()
  })
})
