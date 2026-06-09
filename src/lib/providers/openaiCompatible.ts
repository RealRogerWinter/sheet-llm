import { RateLimitedError, UpstreamError } from '@/lib/llm/errors'
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCapabilities,
  ProviderName,
  ProviderTool,
  ProviderToolResult,
  ProviderUsage,
} from './types'
import { OutputTruncatedError, ProviderRefusalError, ProviderSchemaError } from './types'
import { flattenSystemPrompt } from './systemBlocks'
import { recordProviderCall } from '@/lib/metering/usageMeter'

/** Default per-call output ceiling when a caller doesn't set `maxTokens`.
 *  Lower than Anthropic's 8000 — a Groq emit large enough to exceed this is
 *  truncated (finish_reason 'length') and surfaced as OutputTruncatedError. */
const DEFAULT_MAX_TOKENS = 2_000

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
      throw new UpstreamError(`${this.config.apiKeyEnv} is not set`, 500)
    }
    return v
  }

  /**
   * Build OpenAI-style messages. PR C: only handles single-shot
   * (system + user text). Multi-turn history support (for generateSimple
   * once it migrates) lands in a follow-up — needs ChatMessage→OpenAI
   * conversion for tool_use / tool_result blocks.
   */
  private buildMessages(options: ProviderCallOptions): Array<Record<string, unknown>> {
    if (options.history) {
      throw new Error(
        `${this.name}: history-mode toolCall not yet implemented for OpenAI-compatible providers`,
      )
    }
    return [
      { role: 'system', content: flattenSystemPrompt(options.systemPrompt) },
      { role: 'user', content: options.userText ?? '' },
    ]
  }
}
