import type { ChatMessage } from '@/lib/llm/wrapper'
import { getLLMClient } from '@/lib/llm'
import { completeWithRetry } from '@/lib/llm/messages'
import type { Classification, OrchestratorResult } from '../types'

const SONNET_MODEL = 'claude-sonnet-4-6'

export interface RunGenerateSimpleInput {
  classification: Classification
  history: ReadonlyArray<ChatMessage>
}

/**
 * Wrap the legacy single-shot Sonnet 4.6 path. The conversation
 * history (transcript including the new user turn) is the LLM input.
 *
 * In Phase 1 this is functionally identical to what route.ts does on
 * the fall-through path. The point of routing here is so that
 * generate_complex / compose in Phase 3 can swap in Opus + a
 * different system prompt without re-doing the orchestrator wiring.
 */
export async function runGenerateSimple(
  input: RunGenerateSimpleInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  const { response } = await completeWithRetry(getLLMClient(), {
    messages: [...input.history],
  })
  return {
    score: response.score,
    introText: response.introText,
    classification: input.classification,
    model: SONNET_MODEL,
    latencyMs: Date.now() - t0,
    toolUseId: response.toolUseId,
  }
}
