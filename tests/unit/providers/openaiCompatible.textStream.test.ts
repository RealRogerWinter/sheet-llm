import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleProvider } from '@/lib/providers/openaiCompatible'
import { RateLimitedError } from '@/lib/llm/errors'
import type { TextStreamEvent } from '@/lib/providers/types'

function makeProvider() {
  return new OpenAICompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-20b',
    capabilities: { promptCaching: false, nativeToolUse: 'native', strictJsonSchema: true, estimatedCallMs: 800 },
  })
}

/** Build a streaming Response whose body emits the given SSE frames. */
function sseResponse(frames: string[], opts: { ok?: boolean; status?: number } = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body,
    text: async () => '',
  } as unknown as Response
}

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

async function collect(it: AsyncIterable<TextStreamEvent>): Promise<TextStreamEvent[]> {
  const out: TextStreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('OpenAICompatibleProvider.textStream', () => {
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

  it('yields message-start, text deltas, then message-stop with finalText/stopReason/usage', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        deltaFrame('Hello'),
        deltaFrame(', '),
        deltaFrame('world'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    )
    const provider = makeProvider()
    const events = await collect(provider.textStream({ systemPrompt: 'sys', userText: 'hi' }))

    expect(events[0]).toEqual({ type: 'message-start', model: 'openai/gpt-oss-20b' })
    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta)
    expect(deltas.join('')).toBe('Hello, world')

    const stop = events[events.length - 1]
    expect(stop).toMatchObject({
      type: 'message-stop',
      finalText: 'Hello, world',
      stopReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
    })

    // text-only request: no tools, stream + include_usage set.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.tools).toBeUndefined()
    expect(body.messages[0].role).toBe('system')
  })

  it('splits SSE frames that arrive across chunk boundaries', async () => {
    // A single delta JSON split mid-frame across two network chunks.
    const full = deltaFrame('chunked')
    const mid = Math.floor(full.length / 2)
    fetchMock.mockResolvedValue(
      sseResponse([full.slice(0, mid), full.slice(mid), 'data: [DONE]\n\n']),
    )
    const provider = makeProvider()
    const events = await collect(provider.textStream({ systemPrompt: 'sys', userText: 'hi' }))
    const stop = events[events.length - 1] as { type: string; finalText: string }
    expect(stop.finalText).toBe('chunked')
  })

  it('aborts mid-stream via the output-budget guard with a clean max_tokens stop', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([deltaFrame('this is well over the tiny budget'), 'data: [DONE]\n\n']),
    )
    const provider = makeProvider()
    const events = await collect(
      provider.textStream({ systemPrompt: 'sys', userText: 'hi', outputTokenBudget: 1 }),
    )
    const stop = events[events.length - 1]
    expect(stop).toMatchObject({ type: 'message-stop', stopReason: 'max_tokens' })
    // Guard tripped, so no usage chunk processed.
    expect((stop as { usage?: unknown }).usage).toBeUndefined()
  })

  it('throws RateLimitedError on a pre-stream 429 (after message-start)', async () => {
    fetchMock.mockResolvedValue(sseResponse([], { ok: false, status: 429 }))
    const provider = makeProvider()
    await expect(collect(provider.textStream({ systemPrompt: 'sys', userText: 'hi' }))).rejects.toThrow(
      RateLimitedError,
    )
  })

  it('yields an error event when the stream body errors mid-flight', async () => {
    // Pull-based so the first read delivers the chunk and the SECOND errors
    // (calling error() right after enqueue in start() discards the queue).
    let step = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) {
          controller.enqueue(new TextEncoder().encode(deltaFrame('partial')))
          step += 1
        } else {
          controller.error(new Error('connection reset'))
        }
      },
    })
    fetchMock.mockResolvedValue({ ok: true, status: 200, body, text: async () => '' } as unknown as Response)
    const provider = makeProvider()
    const events = await collect(provider.textStream({ systemPrompt: 'sys', userText: 'hi' }))
    const last = events[events.length - 1]
    expect(last.type).toBe('error')
    expect((last as { error: Error }).error.message).toMatch(/connection reset/)
    // Partial text streamed before the error.
    expect(events.some((e) => e.type === 'text-delta')).toBe(true)
  })
})
