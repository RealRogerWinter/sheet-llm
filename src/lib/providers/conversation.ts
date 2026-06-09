/**
 * Provider-agnostic conversation IR (SHE-17).
 *
 * This is the neutral representation of multi-turn history that every
 * provider adapts from — including Anthropic. It deliberately imports
 * NOTHING from `@anthropic-ai/sdk`: the core speaks this shape, and each
 * provider owns the translation to its own wire format
 * (see `anthropicConversation.ts`, and the OpenAI adapter in
 * `openaiCompatible.ts`).
 *
 * Field naming is intentionally camelCase (`toolUseId`, `isError`) so the
 * IR is visibly NOT the Anthropic wire shape (which is `tool_use_id` /
 * `is_error`). Adapters map between the two.
 *
 * Scope note: `tool_result` content is modelled as a plain string because
 * that is the only shape this app ever produces (the route, scoreRetry,
 * and the legacy retry path all pass a string). The Anthropic block type
 * also permits an array of sub-blocks; if that ever appears in stored
 * history the round-trip golden test (`conversation.test.ts`) trips,
 * which is the intended tripwire to extend this IR.
 */

/** Plain-text block — an optional intro on either role. */
export interface NeutralTextBlock {
  type: 'text'
  text: string
}

/** Assistant tool invocation carrying the structured tool input. */
export interface NeutralToolUseBlock {
  type: 'tool_use'
  /** The provider-minted tool-use id. */
  id: string
  /** Tool name (e.g. `render_score`). */
  name: string
  /** Parsed tool input (the structured payload, already an object). */
  input: Record<string, unknown>
}

/** User-turn result that closes a prior tool_use by id. */
export interface NeutralToolResultBlock {
  type: 'tool_result'
  /** References the `id` of the tool_use this result answers. */
  toolUseId: string
  /** Result body (always a string in this app — see module note). */
  content: string
  /** Set when the result reports a validation/error condition. */
  isError?: boolean
}

/** Blocks allowed on a user turn. */
export type NeutralUserBlock = NeutralTextBlock | NeutralToolResultBlock

/** Blocks allowed on an assistant turn. */
export type NeutralAssistantBlock = NeutralTextBlock | NeutralToolUseBlock

/**
 * One neutral conversation turn. The user/assistant split mirrors the
 * provider message roles; the block unions enforce that only a user turn
 * carries tool_result and only an assistant turn carries tool_use.
 */
export type NeutralMessage =
  | { role: 'user'; content: NeutralUserBlock[] }
  | { role: 'assistant'; content: NeutralAssistantBlock[] }
