import type { z } from 'zod'
import type { ChatMessage } from '@/lib/llm/wrapper'

/** All providers that the registry can route to. */
export type ProviderName = 'anthropic' | 'groq' | 'ollama'

/** Tiers map orchestrator-classified scope/complexity to a model size. */
export type Tier = 'small' | 'medium' | 'large'

/** Reasoning-effort levels for `output_config.effort` (Sonnet 4.6 / Opus 4.5+). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ProviderCapabilities {
  /** Whether the provider supports prompt caching (Anthropic ephemeral). */
  promptCaching: boolean
  /** How reliably the provider returns parsed tool inputs. */
  nativeToolUse: 'native' | 'fragile' | 'none'
  /** Whether `response_format: json_schema, strict: true` is supported. */
  strictJsonSchema: boolean
  /** Rough wall-clock estimate per call (ms) for deadline guards. */
  estimatedCallMs: number
}

export interface ModelEntry {
  /** Provider-specific model id (e.g. 'claude-haiku-4-5-20251001'). */
  modelId: string
  capabilities: ProviderCapabilities
}

/**
 * Per-call tool definition. The provider translates this to the
 * native tool-use shape (Anthropic input_schema, OpenAI function
 * parameters, etc.). The zod schema is the source of truth for
 * input validation post-parse.
 */
export interface ProviderTool<T> {
  name: string
  description?: string
  /** Zod schema used to validate the LLM-emitted tool input. */
  inputSchema: z.ZodSchema<T>
  /** Raw JSON Schema for the API tool-definition. */
  inputSchemaJson: Record<string, unknown>
  /**
   * Request strict (grammar-constrained) tool use so the emitted input is
   * guaranteed to match the JSON schema. Only enable on tools whose schema
   * is small enough to compile — Anthropic rejects very large schemas as
   * "compiled grammar too large" (render_score is the known offender). The
   * provider forwards this only to models that support strict tool use;
   * the post-parse zod validation stays as the backstop either way.
   */
  strict?: boolean
}

/**
 * One block of the system prompt. When `systemPrompt` is an array of
 * SystemBlocks, providers that support per-block prompt caching
 * (currently Anthropic) emit one `cache_control: ephemeral` marker per
 * block flagged with `cache: true`. Providers without per-block
 * caching flatten the array to a single concatenated string.
 *
 * Use this to share a fragment (e.g. multi-staff schema reference)
 * across handlers without duplicating its cache footprint per handler.
 */
export interface SystemBlock {
  text: string
  /** When true, hint the provider to cache this block independently. */
  cache?: boolean
}

export interface ProviderCallOptions {
  systemPrompt: string | SystemBlock[]
  /** Single-shot user text (when `history` is not used). */
  userText?: string
  /** Multi-turn conversation history (alternative to userText). */
  history?: ReadonlyArray<ChatMessage>
  /** Forces the model to call the given tool by name. Omit on text-only
   *  (non-tool) streaming calls — see `LLMProvider.textStream`. */
  toolChoice?: 'required'
  /** Per-call max output tokens. */
  maxTokens?: number
  /**
   * SECONDARY streaming kill-switch (M26 PR-2). When a streaming call
   * (`textStream`) is given an `outputTokenBudget` and/or `streamDeadlineAt`,
   * the provider builds an output-budget guard and aborts the stream mid-flight
   * the instant the estimated output exceeds the budget OR the wall-clock
   * deadline passes, translating the abort into a clean `message-stop`
   * (stopReason 'max_tokens'). Unset leaves today's behavior (`max_tokens`
   * only). `abortSignal` additionally lets a caller cancel the request
   * externally (also caught and surfaced cleanly). Gated by `SL_STREAM_ABORT`
   * at the caller. */
  abortSignal?: AbortSignal
  /** Estimated-output-token budget for the streaming guard (chars/3.5). */
  outputTokenBudget?: number
  /** Absolute epoch-ms deadline the streaming guard watches. */
  streamDeadlineAt?: number
  /** Per-call temperature (0 = deterministic). Silently dropped for models
   *  that reject sampling params (Opus 4.7+ return 400 on temperature). */
  temperature?: number
  /**
   * Reasoning effort (`output_config.effort`). Lower = fewer tokens. Sonnet
   * 4.6 defaults to `high` when unset, so set this explicitly on
   * deterministic structured-emit calls to cut cost. Silently dropped on
   * models that don't support it (Haiku 4.5, Sonnet 4.5 and older).
   */
  effort?: Effort
  /**
   * Extended-thinking mode. `'disabled'` turns thinking off (cheaper /
   * faster — right for forced single-tool emission); `'adaptive'` lets the
   * model decide (Sonnet 4.6 / Opus 4.6+). Unset leaves the model default.
   */
  thinking?: 'disabled' | 'adaptive'
  /** Debug override: force a specific model id, bypassing tier->model selection. */
  modelOverride?: string
  /**
   * Per-call API key (from the debug panel). When set, the provider
   * uses this key instead of the env var so a long-lived stream can't
   * race with the route's env-var restore.
   */
  apiKeyOverride?: string
  /** Provider-specific extras. Each provider ignores fields it doesn't recognize. */
  providerOptions?: {
    anthropic?: {
      /** Apply cache_control: ephemeral on system + tool blocks. */
      cacheControl?: 'ephemeral' | 'none'
    }
  }
}

export interface ProviderToolResult<T> {
  /** Parsed + zod-validated tool input. */
  input: T
  /** The tool_use id minted by the provider. */
  toolUseId: string
  /** Effective model id used. */
  model: string
  /** Normalised stop reason from the provider ('end_turn' | 'max_tokens' |
   *  'tool_use' | string). Lets callers detect truncation explicitly. */
  stopReason?: string
  /** Optional intro/explanation text emitted alongside the tool call. */
  introText?: string
  /** Token usage (for budget tracking + observability). */
  usage?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  }
}

/**
 * One event from a streaming text completion. Providers that don't
 * support streaming omit `textStream` entirely; callers (currently
 * just runConverse) check for its presence and fall through otherwise.
 */
export type TextStreamEvent =
  | { type: 'message-start'; model: string }
  | { type: 'text-delta'; delta: string }
  | {
      type: 'message-stop'
      /** Full accumulated text from the provider's finalMessage(), if available. */
      finalText: string
      /** Normalised reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string. */
      stopReason?: string
      usage?: {
        inputTokens?: number
        cachedInputTokens?: number
        outputTokens?: number
      }
    }
  | { type: 'error'; error: Error }

/**
 * Provider-agnostic LLM call surface. Each LLM-calling orchestrator
 * handler routes through this interface so the underlying provider
 * (Anthropic / Groq / Ollama / future) can be swapped per tier.
 */
export interface LLMProvider {
  name: ProviderName
  /**
   * Make a tool-use call. Returns the parsed tool input or throws
   * one of: ProviderSchemaError (input failed zod validation),
   * ProviderRefusalError (model refused), RateLimitedError,
   * UpstreamError.
   */
  toolCall<T>(tool: ProviderTool<T>, options: ProviderCallOptions): Promise<ProviderToolResult<T>>
  /**
   * Optional: stream a text-only (non-tool) completion. The iterator
   * yields message-start, then zero-or-more text-delta, then exactly
   * one of message-stop or error. The consumer owns lifecycle and
   * MUST iterate to completion or call .return() to release the
   * underlying SDK stream.
   */
  textStream?(options: ProviderCallOptions): AsyncIterable<TextStreamEvent>
}

export class ProviderSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderSchemaError'
  }
}

export class ProviderRefusalError extends Error {
  /** Provider-side refusal reason if available. */
  refusalReason?: string
  constructor(message: string, refusalReason?: string) {
    super(message)
    this.name = 'ProviderRefusalError'
    this.refusalReason = refusalReason
  }
}

/**
 * The model hit its max_tokens ceiling before finishing the tool call,
 * so the emitted tool input is truncated/incomplete (a required array
 * can be missing). Distinct from ProviderSchemaError (genuinely
 * malformed-but-COMPLETE output): truncation is recoverable by emitting
 * less per call (sectional generation) and must NOT count toward provider
 * degradation — `callWithFailover` deliberately skips reporting it, so a
 * big-piece truncation never demotes the chat to a weaker fallback model.
 * Carries the token budget for diagnostics.
 */
export class OutputTruncatedError extends Error {
  readonly maxTokens?: number
  readonly outputTokens?: number
  constructor(message: string, opts?: { maxTokens?: number; outputTokens?: number }) {
    super(message)
    this.name = 'OutputTruncatedError'
    this.maxTokens = opts?.maxTokens
    this.outputTokens = opts?.outputTokens
  }
}
