import type Anthropic from '@anthropic-ai/sdk'
import type { Score } from '@/lib/music/types'

/**
 * User-turn content blocks: either bare text (first turn) or a
 * tool_result block (refinement turn) optionally followed by text.
 */
export type UserContentBlock =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ToolResultBlockParam

/**
 * Assistant-turn content blocks: text (optional intro) + the
 * tool_use that carries the structured Score.
 */
export type AssistantContentBlock =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ToolUseBlockParam

/**
 * One conversation turn. Stored in native Anthropic shape so the
 * transcript can be passed directly to the API and so prompt-cache
 * byte equality is preserved across turns.
 */
export type ChatMessage =
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }

export interface LLMCompleteRequest {
  messages: ChatMessage[]
  /**
   * Optional per-request output ceiling (`max_tokens`). The real client uses
   * it when set, else its own default. The route passes it to bound the
   * free-tier legacy fall-through so it can't run an unbounded generation.
   */
  maxTokens?: number
}

export interface LLMResponse {
  score: Score
  introText?: string
  /**
   * The tool_use id Claude assigned to this render_score call.
   * The route needs it to build the next refinement turn's
   * tool_result block (which must reference this id).
   */
  toolUseId: string
}

/**
 * LLM abstraction. Phase 5: messages now carry content blocks
 * (text / tool_use / tool_result) so the model sees its prior
 * structured score and can edit it.
 */
export interface LLMClient {
  complete(req: LLMCompleteRequest): Promise<LLMResponse>
}
