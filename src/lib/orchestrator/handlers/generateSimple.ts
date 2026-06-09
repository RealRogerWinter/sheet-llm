import type { ChatMessage } from '@/lib/llm/wrapper'
import { selectProvider } from '@/lib/providers/select'
import { fromAnthropicMessagesLenient } from '@/lib/providers/anthropicConversation'
import { renderScoreTool } from '@/lib/llm/renderScoreTool'
import { SYSTEM_PROMPT } from '@/lib/llm/systemPrompt'
import { recordUsage } from '../budget'
import type { Classification, OrchestratorResult } from '../types'
import { callWithScoreRetry } from './scoreRetry'

const MAX_TOKENS = 8_000 // matches the legacy realClient default (client.ts)

export interface RunGenerateSimpleInput {
  classification: Classification
  /** The conversation transcript (incl. the new user turn) — the LLM input. */
  history: ReadonlyArray<ChatMessage>
  chatId: string
  /** Debug / eval: force a specific model id (e.g. a Groq model). */
  modelOverride?: string
  apiKeyOverride?: string
}

/**
 * Fresh-generation fall-through. Previously hard-wired to the legacy
 * Anthropic client (Sonnet, `getLLMClient`/`realClient`), which ignored
 * `modelOverride` so fresh first-turn generation could not run on a
 * non-Anthropic provider. SHE-17 routes it through the provider registry
 * instead, so it respects `modelOverride` (and per-chat provider selection /
 * failover) like every other handler.
 *
 * Behavior preservation: with no override this resolves to the medium tier
 * (Sonnet) and, because the render_score tool description is forwarded and
 * the base SYSTEM_PROMPT is used with ephemeral caching, the Anthropic
 * request is byte-identical to the legacy `realClient` path (pinned by
 * generateSimple.test.ts). The stored transcript is adapted to the neutral
 * IR LENIENTLY so a corrupt/legacy row can't make the conversation
 * un-loadable (the PR1 S1 finding).
 */
export async function runGenerateSimple(
  input: RunGenerateSimpleInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()

  const selected = selectProvider('medium', input.chatId)
  const effectiveModel = input.modelOverride ?? selected.model

  const history = fromAnthropicMessagesLenient(input.history)

  const result = await callWithScoreRetry(
    { ...selected, chatId: input.chatId },
    {
      systemPrompt: SYSTEM_PROMPT,
      history,
      toolDescription: renderScoreTool.description,
      maxTokens: MAX_TOKENS,
      modelOverride: effectiveModel,
      ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
    },
  )

  recordUsage(input.chatId, result.usage?.inputTokens, result.usage?.outputTokens)

  return {
    score: result.input,
    introText: result.introText,
    classification: input.classification,
    model: result.model,
    latencyMs: Date.now() - t0,
    toolUseId: result.toolUseId,
    ...(result.usage
      ? {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
          },
        }
      : {}),
  }
}
