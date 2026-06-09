import { RateLimitedError, UpstreamError, ProviderNotConfiguredError } from '@/lib/llm/errors'
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCapabilities,
  ProviderName,
  ProviderTool,
  ProviderToolResult,
  ProviderUsage,
  TextStreamEvent,
} from './types'
import { OutputTruncatedError, ProviderRefusalError, ProviderSchemaError } from './types'
import { flattenSystemPrompt } from './systemBlocks'
import { toOpenAIMessages } from './openaiConversation'
import { makeOutputBudgetGuard } from './streamGuard'
import { recordProviderCall } from '@/lib/metering/usageMeter'

/** Default per-call output ceiling when a caller doesn't set `maxTokens`.
 *  Lower than Anthropic's 8000 — a Groq emit large enough to exceed this is
 *  truncated (finish_reason 'length') and surfaced as OutputTruncatedError. */
const DEFAULT_MAX_TOKENS = 2_000

/** Hard cap on the unframed SSE read buffer (a single delimiter-free run).
 *  Legitimate Chat Completions frames are well under a KB; 1 MB is a
 *  generous protocol-violation ceiling that bounds memory against a
 *  newline-free or hostile upstream stream. */
const MAX_SSE_BUFFER_BYTES = 1_048_576

export interface OpenAICompatibleConfig {
  name: ProviderName
  /** API base URL ending in `/v1` (e.g., https://api.groq.com/openai/v1). */
  baseUrl: string
  /** Env var holding the API key. Empty string for keyless backends (Ollama). */
  apiKeyEnv: string
  /** Default model id when callers don't supply one. */
  defaultModel: string
  capabilities: ProviderCapabilities
  /**
   * Optional hook for provider-specific request body extensions.
   * Used by Ollama to add `format: <jsonSchema>` (grammar-constrained
   * sampling) which lives outside the standard OpenAI shape.
   */
  extendRequestBody?: (body: Record<string, unknown>, tool: ProviderTool<unknown>) => void
}

interface OpenAIChatCompletionResponse {
  id?: string
  model?: string
  choices?: Array<{
    finish_reason?: string
    message?: {
      role?: string
      content?: string | null
      refusal?: string | null
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** One SSE chunk from a `stream: true` Chat Completions response. */
interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/**
 * Generic provider for any OpenAI Chat Completions-compatible endpoint:
 * Groq (`https://api.groq.com/openai/v1`), Ollama
 * (`http://localhost:11434/v1`), OpenAI itself, xAI, etc.
 *
 * Subclasses override only config (base URL, default model, capabilities,
 * extendRequestBody hook). Tool-call response shape is OpenAI standard:
 * `message.tool_calls[].function.arguments` is a JSON STRING (unlike
 * Anthropic's pre-parsed object), so we JSON.parse then zod-validate.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  name: ProviderName
  protected config: OpenAICompatibleConfig

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name
    this.config = config
  }

  async toolCall<T>(
    tool: ProviderTool<T>,
    options: ProviderCallOptions,
  ): Promise<ProviderToolResult<T>> {
    const apiKey = this.resolveApiKey()
    const model = options.modelOverride ?? this.config.defaultModel
    const messages = this.buildMessages(options)

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      tools: [
        {
          type: 'function',
          function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.inputSchemaJson,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: tool.name } },
    }

    this.config.extendRequestBody?.(body, tool as ProviderTool<unknown>)

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'network error'
      throw new UpstreamError(`${this.name}: ${msg}`, 502)
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new RateLimitedError(`${this.name}: rate limited`)
      }
      const text = await response.text().catch(() => '')
      throw new UpstreamError(
        `${this.name} ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      )
    }

    const data = (await response.json()) as OpenAIChatCompletionResponse
    const choice = data.choices?.[0]
    const message = choice?.message
    if (!message) {
      throw new UpstreamError(`${this.name}: no message in response`, 500)
    }

    // Normalised usage, hoisted so the truncation / refusal paths can meter the
    // tokens the provider already billed before we throw.
    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens,
          outputTokens: data.usage.completion_tokens,
        }
      : undefined
    const effectiveModel = data.model ?? model

    // Structured refusal (OpenAI / gpt-oss `message.refusal`) is an explicit
    // model decision — classify it first, distinct from truncation/schema.
    if (typeof message.refusal === 'string' && message.refusal.length > 0) {
      recordProviderCall(effectiveModel, usage)
      throw new ProviderRefusalError(`${this.name}: model refused the request`, message.refusal)
    }

    // `finish_reason: 'length'` means the response was cut at max_tokens. That
    // only makes the call a FAILURE if the tool arguments are actually unusable
    // (missing / un-parseable / schema-invalid). A complete, valid tool call is
    // returned as success even under a length cap — so a verbose-but-correct
    // model is not falsely scored as truncated. When a length cut DOES leave the
    // output unusable we throw OutputTruncatedError (recoverable, kept off the
    // degradation ladder) instead of a misleading schema error.
    const truncated = choice?.finish_reason === 'length'

    const toolCall = message.tool_calls?.[0]
    if (!toolCall || toolCall.function?.name !== tool.name) {
      if (truncated) this.throwTruncated(tool.name, options, usage, effectiveModel)
      throw new ProviderSchemaError(
        toolCall
          ? `${this.name}: model called wrong tool "${toolCall.function?.name}" instead of "${tool.name}"`
          : `${this.name}: model did not call "${tool.name}"; content: ${(message.content ?? '').slice(0, 200)}`,
      )
    }

    const args = toolCall.function?.arguments ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(args)
    } catch (e) {
      if (truncated) this.throwTruncated(tool.name, options, usage, effectiveModel)
      throw new ProviderSchemaError(
        `${this.name}: tool arguments for "${tool.name}" are not valid JSON: ${
          e instanceof Error ? e.message : 'parse error'
        }`,
      )
    }

    const validated = tool.inputSchema.safeParse(parsed)
    if (!validated.success) {
      if (truncated) this.throwTruncated(tool.name, options, usage, effectiveModel)
      throw new ProviderSchemaError(
        `${this.name}: tool input for "${tool.name}" failed schema validation: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      )
    }

    recordProviderCall(effectiveModel, usage)
    return {
      input: validated.data,
      toolUseId: toolCall.id ?? `${this.name}_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`,
      model: effectiveModel,
      stopReason: choice?.finish_reason,
      introText:
        typeof message.content === 'string' && message.content.length > 0
          ? message.content
          : undefined,
      usage,
    }
  }

  /**
   * Stream a text-only (non-tool) completion via OpenAI Chat Completions
   * SSE (`stream: true`). Mirrors AnthropicProvider.textStream's event
   * contract so converse/Q&A is provider-agnostic: yields `message-start`,
   * zero-or-more `text-delta`, then exactly one `message-stop` or `error`.
   *
   * Pre-stream failures (rate limit, 4xx/5xx, no body) THROW (same channel
   * as toolCall); mid-stream failures are yielded as `{ type: 'error' }` so
   * the caller can persist partial output. The secondary output-budget /
   * deadline guard aborts mid-flight (inert unless opted in), and an
   * external `abortSignal` cancels cleanly — both surface as a
   * truncation-style `message-stop` (stopReason 'max_tokens'), not an error.
   */
  async *textStream(options: ProviderCallOptions): AsyncIterable<TextStreamEvent> {
    const apiKey = this.resolveApiKey()
    const model = options.modelOverride ?? this.config.defaultModel
    const messages = this.buildMessages(options)

    yield { type: 'message-start', model }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      // Ask OpenAI-compatible backends (Groq) to include usage in the final
      // chunk; absent on backends that don't support it (we just skip metering).
      stream_options: { include_usage: true },
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'network error'
      throw new UpstreamError(`${this.name}: ${msg}`, 502)
    }

    if (!response.ok) {
      if (response.status === 429) throw new RateLimitedError(`${this.name}: rate limited`)
      const text = await response.text().catch(() => '')
      throw new UpstreamError(`${this.name} ${response.status}: ${text.slice(0, 300)}`, response.status)
    }
    if (!response.body) {
      throw new UpstreamError(`${this.name}: streaming response has no body`, 502)
    }

    const guard = makeOutputBudgetGuard({
      ...(options.outputTokenBudget !== undefined ? { outputTokenBudget: options.outputTokenBudget } : {}),
      ...(options.streamDeadlineAt !== undefined ? { deadlineAt: options.streamDeadlineAt } : {}),
    })

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let accumulated = ''
    let stopReason: string | undefined
    let usage: ProviderUsage | undefined
    let aborted = false

    try {
      reading: for (;;) {
        // Evaluate the budget/deadline guard once per iteration (not only in
        // the text-delta branch) so the wall-clock deadline fires even when no
        // deltas are arriving — keep-alives, empty deltas, or byte-drip.
        if (guard.shouldAbort(accumulated.length)) {
          aborted = true
          break
        }
        // Race the read against the deadline so a fully-stalled socket (read
        // never resolves) can't hold the stream open past the deadline.
        const read = await this.readWithDeadline(reader, options.streamDeadlineAt)
        if (read.timedOut) {
          aborted = true
          break
        }
        if (read.done) break
        buffer += decoder.decode(read.value, { stream: true })
        // Cap the unframed buffer: legitimate SSE frames are tiny, so a
        // newline-free (malicious / buggy) upstream that grows `buffer`
        // without bound is a protocol violation, not data we should retain.
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          throw new UpstreamError(
            `${this.name}: SSE stream exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a frame delimiter`,
            502,
          )
        }
        // SSE frames are newline-delimited `data: {json}` lines; keep the
        // trailing partial line in the buffer for the next chunk.
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '' || data === '[DONE]') continue
          let frame: OpenAIStreamChunk
          try {
            frame = JSON.parse(data) as OpenAIStreamChunk
          } catch {
            continue // ignore keep-alive / malformed frames
          }
          const choice = frame.choices?.[0]
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta
            yield { type: 'text-delta', delta }
            if (guard.shouldAbort(accumulated.length)) {
              aborted = true
              break reading
            }
          }
          if (choice?.finish_reason) stopReason = choice.finish_reason
          if (frame.usage) {
            usage = {
              inputTokens: frame.usage.prompt_tokens,
              cachedInputTokens: frame.usage.prompt_tokens_details?.cached_tokens,
              outputTokens: frame.usage.completion_tokens,
            }
          }
        }
      }

      if (aborted) {
        yield { type: 'message-stop', finalText: accumulated, stopReason: 'max_tokens' }
        return
      }
      if (usage) recordProviderCall(model, usage)
      yield {
        type: 'message-stop',
        finalText: accumulated,
        stopReason,
        ...(usage ? { usage } : {}),
      }
    } catch (e) {
      // External abort (caller's abortSignal) surfaces here as an AbortError —
      // translate to a clean truncation-style stop, not an error event.
      if (options.abortSignal?.aborted) {
        yield { type: 'message-stop', finalText: accumulated, stopReason: 'max_tokens' }
        return
      }
      const err = e instanceof Error ? e : new Error(`${this.name}: unknown stream error`)
      yield { type: 'error', error: err }
    } finally {
      // Release the HTTP stream on EVERY exit path — normal completion,
      // guard/deadline abort, mid-stream error, AND consumer early `.return()`
      // (the documented escape hatch). cancel() is a no-op on an already-closed
      // stream, so double-cancel from the abort paths is harmless.
      await reader.cancel().catch(() => {})
    }
  }

  /**
   * Read one chunk, racing it against the stream's wall-clock deadline so a
   * silently-stalled socket can't block past it. Returns `{ timedOut: true }`
   * when the deadline passes before a chunk arrives.
   */
  private async readWithDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    deadlineAt: number | undefined,
  ): Promise<{ done: boolean; value?: Uint8Array; timedOut: boolean }> {
    if (deadlineAt === undefined) {
      const r = await reader.read()
      return { done: r.done, value: r.value, timedOut: false }
    }
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return { done: false, timedOut: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), remaining)
    })
    try {
      const r = await Promise.race([
        reader.read().then((x) => ({ done: x.done, value: x.value, timedOut: false as const })),
        timeout,
      ])
      return 'done' in r ? r : { done: false, timedOut: true }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Meter the (already-billed) tokens and throw a typed truncation error.
   * `never`-returning so call sites read as a guard. Reports the EFFECTIVE
   * ceiling so the lower Groq default (vs Anthropic's 8000) is visible in
   * truncation diagnostics.
   */
  private throwTruncated(
    toolName: string,
    options: ProviderCallOptions,
    usage: ProviderUsage | undefined,
    effectiveModel: string,
  ): never {
    recordProviderCall(effectiveModel, usage)
    throw new OutputTruncatedError(
      `${this.name}: "${toolName}" hit the max_tokens ceiling (${options.maxTokens ?? DEFAULT_MAX_TOKENS}) before the tool call completed`,
      {
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      },
    )
  }

  private resolveApiKey(): string | undefined {
    if (!this.config.apiKeyEnv) return undefined // keyless (Ollama)
    const v = process.env[this.config.apiKeyEnv]
    if (!v) {
      throw new ProviderNotConfiguredError(this.config.name, this.config.apiKeyEnv)
    }
    return v
  }

  /**
   * Build OpenAI-style messages. Single-shot uses `userText`; multi-turn
   * uses the neutral history (SHE-17), adapted to OpenAI's message model
   * via `toOpenAIMessages` (assistant `tool_calls` + `role:'tool'` results).
   * History-mode is what lets a cheap Groq model run the score-emit
   * validation-retry loop instead of failing it as NO_SCORE.
   */
  private buildMessages(options: ProviderCallOptions): Array<Record<string, unknown>> {
    const system = { role: 'system', content: flattenSystemPrompt(options.systemPrompt) }
    if (options.history) {
      return [system, ...toOpenAIMessages(options.history)]
    }
    return [system, { role: 'user', content: options.userText ?? '' }]
  }
}
