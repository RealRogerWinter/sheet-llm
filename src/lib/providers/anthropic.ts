import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage } from '@/lib/llm/wrapper'
import { RateLimitedError, UpstreamError } from '@/lib/llm/errors'
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderName,
  ProviderTool,
  ProviderToolResult,
  ProviderUsage,
  TextStreamEvent,
} from './types'
import { OutputTruncatedError, ProviderSchemaError } from './types'
import { toSystemBlocks } from './systemBlocks'
import { makeOutputBudgetGuard } from './streamGuard'

/** Per-call output ceiling when the caller doesn't set one. High enough
 *  that a forgotten `maxTokens` won't silently truncate a score. */
const DEFAULT_MAX_TOKENS = 8_000

/**
 * Opus 4.7+ removed sampling params (temperature/top_p/top_k) — sending
 * them returns 400. Every other model (Sonnet 4.6, Haiku 4.5, Opus 4.6 and
 * earlier) still accepts temperature, so we forward it there.
 */
function modelAcceptsTemperature(model: string): boolean {
  return !/opus-4-[789]/.test(model)
}

/**
 * `output_config.effort` is supported on Sonnet 4.6 and Opus 4.5+. Haiku
 * 4.5 and Sonnet 4.5/older return 400 on it, so it's dropped there.
 */
function modelSupportsEffort(model: string): boolean {
  return /sonnet-4-6/.test(model) || /opus-4-[5-9]/.test(model)
}

/**
 * Build the per-call tuning fields (temperature / thinking / effort), each
 * gated by what the resolved model accepts. Returned as a loose record so
 * the caller can spread it into the request body — the Anthropic SDK
 * forwards unknown body fields verbatim, so `output_config` is sent even
 * though older SDK type defs don't name it.
 */
function tuningParams(
  options: ProviderCallOptions,
  model: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (options.temperature !== undefined && modelAcceptsTemperature(model)) {
    out.temperature = options.temperature
  }
  if (options.thinking === 'disabled') {
    out.thinking = { type: 'disabled' }
  } else if (options.thinking === 'adaptive') {
    out.thinking = { type: 'adaptive' }
  }
  if (options.effort !== undefined && modelSupportsEffort(model)) {
    out.output_config = { effort: options.effort }
  }
  return out
}

/**
 * Map the Anthropic wire `usage` object to the normalised ProviderUsage.
 * Captures `cache_creation_input_tokens` (cache-WRITE) — previously dropped,
 * which silently under-counted the first (cold-cache) call of every prefix.
 * A 0 bucket is preserved (it distinguishes a warm-cache call from an absent
 * field); only null/undefined fields are omitted.
 */
export function mapAnthropicUsage(
  u:
    | {
        input_tokens?: number | null
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
        output_tokens?: number | null
      }
    | null
    | undefined,
): ProviderUsage | undefined {
  if (!u) return undefined
  return {
    ...(u.input_tokens != null ? { inputTokens: u.input_tokens } : {}),
    ...(u.cache_read_input_tokens != null ? { cachedInputTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens != null
      ? { cacheCreationInputTokens: u.cache_creation_input_tokens }
      : {}),
    ...(u.output_tokens != null ? { outputTokens: u.output_tokens } : {}),
  }
}

/**
 * AnthropicProvider — preserves the legacy direct-SDK semantics:
 *  - cache_control: ephemeral on system + tool blocks when requested
 *  - native tool_use parsing (Anthropic returns input already as an
 *    object, no JSON.parse needed)
 *  - RateLimitedError / UpstreamError mapping consistent with the
 *    existing llm/client.ts wrapper
 *  - per-model tuning: temperature is dropped for models that reject it
 *    (Opus 4.7+), and effort / thinking are forwarded only where supported
 */
export class AnthropicProvider implements LLMProvider {
  name: ProviderName = 'anthropic'
  private _client: Anthropic | undefined
  private _cachedKey: string | undefined

  /**
   * Returns an Anthropic SDK client for the given key. When `override`
   * is provided we bypass the memoised env-key client and instantiate
   * a one-shot client — this keeps long-lived streams insulated from
   * the route's process.env restore.
   */
  private getClient(override?: string): Anthropic {
    if (override) {
      return new Anthropic({ apiKey: override, maxRetries: 2 })
    }
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new UpstreamError('ANTHROPIC_API_KEY is not set', 500)
    }
    if (!this._client || this._cachedKey !== apiKey) {
      this._client = new Anthropic({ apiKey, maxRetries: 2 })
      this._cachedKey = apiKey
    }
    return this._client
  }

  /** Test-only escape hatch to reset the memoized SDK client. */
  _reset(): void {
    this._client = undefined
    this._cachedKey = undefined
  }

  async toolCall<T>(
    tool: ProviderTool<T>,
    options: ProviderCallOptions,
  ): Promise<ProviderToolResult<T>> {
    const anthropic = this.getClient(options.apiKeyOverride)
    const model = options.modelOverride ?? 'claude-sonnet-4-6'
    const wantsCache = options.providerOptions?.anthropic?.cacheControl !== 'none'

    const systemBlocks = buildSystemBlocks(options.systemPrompt, wantsCache)

    const toolDef = {
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchemaJson as Anthropic.Tool['input_schema'],
      ...(tool.strict ? { strict: true } : {}),
      ...(wantsCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }

    const messages = buildMessages(options)

    let response
    try {
      const body: Record<string, unknown> = {
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: systemBlocks,
        tools: [toolDef],
        tool_choice: { type: 'tool', name: tool.name },
        messages,
        ...tuningParams(options, model),
      }
      response = await anthropic.messages.create(
        body as unknown as Anthropic.MessageCreateParamsNonStreaming,
        options.abortSignal ? { signal: options.abortSignal } : undefined,
      )
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        throw new RateLimitedError(e.message)
      }
      // A caller-driven abort (output-budget / deadline kill-switch) — surface
      // as a clean truncation so it rides the existing OutputTruncatedError ->
      // 422 path and stays OUT of degradation reporting. MUST precede the
      // generic APIError branch (APIUserAbortError extends APIError, so the
      // order matters — otherwise the abort 502s).
      if (e instanceof Anthropic.APIUserAbortError) {
        throw new OutputTruncatedError(
          `${tool.name}: request aborted by the per-request kill-switch`,
          options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : undefined,
        )
      }
      if (e instanceof Anthropic.APIError) {
        throw new UpstreamError(e.message, e.status ?? 502)
      }
      const msg = e instanceof Error ? e.message : 'Unknown Anthropic SDK error'
      throw new UpstreamError(msg, 502)
    }

    // Truncation guard (M25-PR-2): when the model hits max_tokens
    // mid-tool-call, the emitted tool input is incomplete — a required
    // array (e.g. `measures`) is simply absent. Detect it explicitly and
    // BEFORE the zod parse so it surfaces as a typed, recoverable error
    // instead of the misleading "expected array, received undefined"
    // schema failure that read as a cryptic 500.
    if (response.stop_reason === 'max_tokens') {
      const used = (response.usage as { output_tokens?: number } | undefined)?.output_tokens
      throw new OutputTruncatedError(
        `${tool.name}: output hit the max_tokens ceiling (${options.maxTokens ?? 'default'}) before the tool call completed`,
        {
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(used !== undefined ? { outputTokens: used } : {}),
        },
      )
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    if (!toolUse || toolUse.name !== tool.name) {
      const text = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )
      throw new ProviderSchemaError(
        text?.text
          ? `${tool.name}: model returned text instead of calling the tool: ${text.text.slice(0, 200)}`
          : `${tool.name}: model did not call the expected tool (got: ${toolUse?.name ?? 'none'})`,
      )
    }

    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      throw new ProviderSchemaError(
        `Tool input for ${tool.name} failed schema validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      )
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    )

    return {
      input: parsed.data,
      toolUseId: toolUse.id,
      model,
      stopReason: response.stop_reason ?? undefined,
      introText: textBlock?.text,
      usage: mapAnthropicUsage(response.usage),
    }
  }

  /**
   * Stream a text-only completion. Yields message-start, then text-delta
   * events for each model chunk, then exactly one terminal event
   * (message-stop or error). Errors raised before the stream opens
   * (rate limit, 4xx/5xx) are translated to RateLimitedError /
   * UpstreamError so they surface through the same channels as toolCall.
   * Errors raised mid-stream are yielded as `{ type: 'error' }` so the
   * caller can persist partial output and write a clean SSE error frame.
   */
  async *textStream(options: ProviderCallOptions): AsyncIterable<TextStreamEvent> {
    const anthropic = this.getClient(options.apiKeyOverride)
    const model = options.modelOverride ?? 'claude-sonnet-4-6'
    const wantsCache = options.providerOptions?.anthropic?.cacheControl !== 'none'

    const systemBlocks = buildSystemBlocks(options.systemPrompt, wantsCache)
    const messages = buildMessages(options)

    yield { type: 'message-start', model }

    let stream
    try {
      const body: Record<string, unknown> = {
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: systemBlocks,
        messages,
        ...tuningParams(options, model),
      }
      stream = anthropic.messages.stream(
        body as unknown as Anthropic.MessageStreamParams,
        options.abortSignal ? { signal: options.abortSignal } : undefined,
      )
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new RateLimitedError(e.message)
      if (e instanceof Anthropic.APIError) throw new UpstreamError(e.message, e.status ?? 502)
      const msg = e instanceof Error ? e.message : 'Unknown Anthropic SDK error'
      throw new UpstreamError(msg, 502)
    }

    let accumulated = ''
    let aborted = false
    // SECONDARY kill-switch (M26 PR-2): abort the stream mid-flight when the
    // estimated output exceeds the budget OR a wall-clock deadline passes.
    // Inert when neither option is set (shouldAbort always returns false), so
    // this is a no-op on calls that don't opt in.
    const guard = makeOutputBudgetGuard({
      ...(options.outputTokenBudget !== undefined ? { outputTokenBudget: options.outputTokenBudget } : {}),
      ...(options.streamDeadlineAt !== undefined ? { deadlineAt: options.streamDeadlineAt } : {}),
    })
    try {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          accumulated += event.delta.text
          yield { type: 'text-delta', delta: event.delta.text }
          if (guard.shouldAbort(accumulated.length)) {
            aborted = true
            stream.abort()
            break
          }
        }
      }
      if (aborted) {
        // Killed by the guard — surface a clean truncation-style stop carrying
        // whatever streamed so far. Do NOT call finalMessage() (stream aborted).
        yield { type: 'message-stop', finalText: accumulated, stopReason: 'max_tokens' }
        return
      }
      const finalMsg = await stream.finalMessage()
      yield {
        type: 'message-stop',
        finalText: accumulated,
        stopReason: finalMsg.stop_reason ?? undefined,
        usage: mapAnthropicUsage(finalMsg.usage),
      }
    } catch (e) {
      // Our own guard abort (or a caller-supplied abortSignal) can surface here
      // on some SDK paths — translate it to a clean truncation-style stop, NOT
      // an error event. MUST precede the generic APIError branch below
      // (APIUserAbortError extends APIError, so order matters).
      if (e instanceof Anthropic.APIUserAbortError) {
        yield { type: 'message-stop', finalText: accumulated, stopReason: 'max_tokens' }
        return
      }
      // Translate mid-stream upstream errors into an error event so the
      // route can still persist whatever was accumulated.
      const err =
        e instanceof Anthropic.RateLimitError
          ? new RateLimitedError(e.message)
          : e instanceof Anthropic.APIError
            ? new UpstreamError(e.message, e.status ?? 502)
            : e instanceof Error
              ? e
              : new Error('Unknown Anthropic stream error')
      yield { type: 'error', error: err }
    }
  }
}

/**
 * Build the messages array for the Anthropic API.
 *
 * - If `history` is provided (multi-turn refinement), use it directly.
 *   `userText` is ignored — the caller is responsible for having
 *   already appended the current user turn to history.
 * - Otherwise (`userText` only), construct a single first-call user
 *   turn carrying the text.
 */
/**
 * Convert a string-or-blocks system prompt into Anthropic's
 * TextBlockParam[]. Anthropic accepts up to 4 cache_control markers
 * per request; when the caller provides explicit blocks (multi-block
 * layout), each block flagged `cache: true` gets its own ephemeral
 * cache marker. Single-string back-compat: one block, marked cached
 * iff the global `wantsCache` option says so.
 */
function buildSystemBlocks(
  prompt: ProviderCallOptions['systemPrompt'],
  wantsCache: boolean,
): Anthropic.Messages.TextBlockParam[] {
  if (typeof prompt === 'string') {
    return [
      {
        type: 'text',
        text: prompt,
        ...(wantsCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ]
  }
  const blocks = toSystemBlocks(prompt)
  // Cap cache markers at 3 here; the tool definition consumes the 4th
  // slot (Anthropic's per-request limit is 4 cache_control markers).
  let cacheBudget = wantsCache ? 3 : 0
  return blocks.map((b) => {
    const marker = b.cache && cacheBudget > 0
    if (marker) cacheBudget--
    return {
      type: 'text' as const,
      text: b.text,
      ...(marker ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }
  })
}

function buildMessages(options: ProviderCallOptions): ChatMessage[] {
  if (options.history) return [...options.history]
  if (!options.userText) {
    throw new Error('AnthropicProvider.toolCall requires either history or userText')
  }
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: options.userText }],
    },
  ]
}
