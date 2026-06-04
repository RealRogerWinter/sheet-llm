// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

// Mock the Anthropic SDK so toolCall hits a stub instead of the network.
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
const { OutputTruncatedError, ProviderSchemaError } = await import('@/lib/providers/types')

const TOOL = {
  name: 'render_score',
  description: 'render',
  inputSchema: z.object({ measures: z.array(z.unknown()) }),
  inputSchemaJson: { type: 'object', additionalProperties: true, properties: {} },
}
const OPTS = {
  systemPrompt: 'sys',
  userText: 'hi',
  toolChoice: 'required' as const,
  maxTokens: 4000,
}

describe('AnthropicProvider truncation guard (M25-PR-2)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
  })

  it('throws a typed OutputTruncatedError when stop_reason is max_tokens (NOT a schema error)', async () => {
    // The whole bug: a max_tokens cut leaves the tool input incomplete.
    // Pre-fix this surfaced as ProviderSchemaError "expected array,
    // received undefined". Now it must be the typed truncation error.
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 't', name: 'render_score', input: {} }],
      usage: { output_tokens: 4000 },
    })
    const p = new AnthropicProvider()
    const err = await p.toolCall(TOOL, OPTS).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(OutputTruncatedError)
    expect(err).not.toBeInstanceOf(ProviderSchemaError)
    expect(err.maxTokens).toBe(4000)
    expect(err.outputTokens).toBe(4000)
  })

  it('returns parsed input + stopReason on a normal tool_use response', async () => {
    anthropicCreateMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'render_score', input: { measures: [] } }],
      usage: { input_tokens: 5, output_tokens: 6 },
    })
    const p = new AnthropicProvider()
    const r = await p.toolCall(TOOL, OPTS)
    expect(r.input).toEqual({ measures: [] })
    expect(r.stopReason).toBe('tool_use')
  })
})
