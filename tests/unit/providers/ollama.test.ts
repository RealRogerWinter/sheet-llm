import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { OllamaProvider } from '@/lib/providers/ollama'

const SimpleSchema = z.object({ x: z.string() })

function chatResponse(args: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'qwen2.5:14b-instruct',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_ollama_1',
                type: 'function',
                function: { name: 'test_tool', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    }),
    text: async () => '',
  } as unknown as Response
}

describe('OllamaProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.unstubAllEnvs()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('POSTs to localhost:11434/v1/chat/completions by default', async () => {
    fetchMock.mockResolvedValue(chatResponse({ x: 'ok' }))
    const provider = new OllamaProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('honors OLLAMA_BASE_URL env override', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://my-ollama:11500/v1')
    fetchMock.mockResolvedValue(chatResponse({ x: 'ok' }))
    const provider = new OllamaProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    expect(fetchMock.mock.calls[0][0]).toBe('http://my-ollama:11500/v1/chat/completions')
  })

  it('does NOT send an Authorization header (Ollama is keyless)', async () => {
    fetchMock.mockResolvedValue(chatResponse({ x: 'ok' }))
    const provider = new OllamaProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.authorization).toBeUndefined()
  })

  it('adds `format: <jsonSchema>` to the request body for grammar-constrained sampling', async () => {
    fetchMock.mockResolvedValue(chatResponse({ x: 'ok' }))
    const provider = new OllamaProvider()
    await provider.toolCall(
      {
        name: 'test_tool',
        inputSchema: SimpleSchema,
        inputSchemaJson: { type: 'object', properties: { x: { type: 'string' } } },
      },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.format).toEqual({ type: 'object', properties: { x: { type: 'string' } } })
  })

  it('defaults to qwen2.5:14b-instruct as the model', async () => {
    fetchMock.mockResolvedValue(chatResponse({ x: 'ok' }))
    const provider = new OllamaProvider()
    await provider.toolCall(
      { name: 'test_tool', inputSchema: SimpleSchema, inputSchemaJson: {} },
      { systemPrompt: 'sys', userText: 'usr', toolChoice: 'required' },
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('qwen2.5:14b-instruct')
  })
})
