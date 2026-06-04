import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { OpenAICompatibleProvider } from '@/lib/providers/openaiCompatible'
import { ProviderSchemaError } from '@/lib/providers/types'
import { RateLimitedError, UpstreamError } from '@/lib/llm/errors'

const SimpleSchema = z.object({ x: z.string(), y: z.number() })

function makeProvider() {
  return new OpenAICompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-20b',
    capabilities: {
      promptCaching: false,
      nativeToolUse: 'native',
      strictJsonSchema: true,
      estimatedCallMs: 800,
    },
  })
}

function chatCompletionsResponse(args: unknown, opts: { id?: string; content?: string; usage?: unknown; model?: string } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'chatcmpl-abc',
      model: opts.model ?? 'openai/gpt-oss-20b',
      choices: [
        {
          message: {
            role: 'assistant',
            content: opts.content ?? null,
            tool_calls: [
              {
                id: opts.id ?? 'call_test_1',
                type: 'function',
                function: {
                  name: 'test_tool',
                  arguments: typeof args === 'string' ? args : JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
      usage: opts.usage ?? {
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }),
    text: async () => '',
  } as unknown as Response
}

describe('OpenAICompatibleProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('GROQ_API_KEY', 'gsk_test_key')
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('POSTs to baseUrl/chat/completions with Bearer auth', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse({ x: 'a', y: 1 }))
    const provider = makeProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer gsk_test_key')
    expect(init.headers['content-type']).toBe('application/json')
  })

  it('sends OpenAI-style tools array and forces tool_choice', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse({ x: 'a', y: 1 }))
    const provider = makeProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: { type: 'object' } },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'test_tool', parameters: { type: 'object' } },
    })
    expect(body.tool_choice).toMatchObject({ type: 'function', function: { name: 'test_tool' } })
  })

  it('parses tool_call.function.arguments (JSON string) into a typed object', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse({ x: 'hello', y: 42 }))
    const provider = makeProvider()
    const r = await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(r.input).toEqual({ x: 'hello', y: 42 })
    expect(r.toolUseId).toBe('call_test_1')
  })

  it('maps OpenAI usage shape to ProviderToolResult.usage', async () => {
    fetchMock.mockResolvedValue(
      chatCompletionsResponse(
        { x: 'a', y: 1 },
        { usage: { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 150 } } },
      ),
    )
    const provider = makeProvider()
    const r = await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(r.usage).toEqual({ inputTokens: 200, cachedInputTokens: 150, outputTokens: 50 })
  })

  it('throws ProviderSchemaError when arguments are not valid JSON', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse('not-json{{{'))
    const provider = makeProvider()
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(ProviderSchemaError)
  })

  it('throws ProviderSchemaError when tool input fails zod validation', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse({ x: 'a', y: 'not-a-number' }))
    const provider = makeProvider()
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(ProviderSchemaError)
  })

  it('throws ProviderSchemaError when no tool_call was produced', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'I refuse', tool_calls: undefined } }],
      }),
      text: async () => '',
    } as unknown as Response)
    const provider = makeProvider()
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(ProviderSchemaError)
  })

  it('maps 429 to RateLimitedError', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as unknown as Response)
    const provider = makeProvider()
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(RateLimitedError)
  })

  it('maps non-2xx (non-429) to UpstreamError with the API status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    } as unknown as Response)
    const provider = makeProvider()
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(UpstreamError)
  })

  it('throws UpstreamError when API key env is required but missing', async () => {
    vi.stubEnv('GROQ_API_KEY', '')
    const provider = makeProvider()
    await expect(
      provider.toolCall(
        { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
        { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
      ),
    ).rejects.toThrow(UpstreamError)
  })

  it('honors modelOverride', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse({ x: 'a', y: 1 }))
    const provider = makeProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      {
        systemPrompt: 'sys',
        userText: 'usr',
        toolChoice: 'required',
        modelOverride: 'openai/gpt-oss-120b',
      },
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('openai/gpt-oss-120b')
  })

  it('extendRequestBody hook can mutate the request body (Ollama use case)', async () => {
    fetchMock.mockResolvedValue(chatCompletionsResponse({ x: 'a', y: 1 }))
    const provider = new OpenAICompatibleProvider({
      name: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyEnv: '',
      defaultModel: 'qwen2.5:14b-instruct',
      capabilities: { promptCaching: false, nativeToolUse: 'fragile', strictJsonSchema: false, estimatedCallMs: 10_000 },
      extendRequestBody: (body, tool) => {
        body.format = tool.inputSchemaJson
      },
    })
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: { type: 'object' } },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.format).toEqual({ type: 'object' })
  })
})
