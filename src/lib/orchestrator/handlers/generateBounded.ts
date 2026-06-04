import { recordUsage, exceedsBudget } from '../budget'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
import {
  BOUNDED_GENERATION_RULES,
  MULTI_STAFF_REFERENCE,
  PER_NOTE_MARKINGS_REFERENCE,
  TIES_REFERENCE,
} from '@/lib/llm/systemPrompt'
import type { SystemBlock } from '@/lib/providers/types'
import { callWithScoreRetry } from './scoreRetry'
import { BOUNDED_EMIT_CEILING } from '../generationTier'

/**
 * The free-tier bounded generation handler (M26). A fresh from-scratch
 * "generate" is served by ONE `render_score` call — at most 4 bars of grand
 * staff, NO multi-section planner loop, capped by a tight `max_tokens` ceiling
 * that doubles as the per-request kill-switch (an overflow throws the
 * already-handled OutputTruncatedError -> clean 422, never a runaway).
 *
 * Token discipline (see the claude-api skill): the large STATIC prompt prefix
 * is prefix-cached (cache_control: ephemeral), the model runs at effort:'low'
 * with thinking disabled, and the only volatile content (the user prompt + a
 * bar-cap reminder) rides in userText AFTER the cached prefix so the cache is
 * reused turn-over-turn.
 *
 * NOTE: this file is intentionally NOT in tokenBudget.test.ts's
 * RENDER_SCORE_EMITTERS, and the ceiling is imported as BOUNDED_EMIT_CEILING
 * (not a `const MAX_TOKENS`) so the >=8000 drift guard does not apply — the
 * bounded emit is meant to be far below the whole-score floor.
 */
export class GenerateBoundedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerateBoundedError'
  }
}

// Frozen role FIRST (no per-request interpolation), then the large shared
// references (cache: true). A single breakpoint on the LAST one caches the
// whole static prefix (see buildSystemBlocks); the render_score tool schema is
// cached separately on the tool definition.
const BOUNDED_SYSTEM_BLOCKS: SystemBlock[] = [
  { text: BOUNDED_GENERATION_RULES },
  { text: MULTI_STAFF_REFERENCE, cache: true },
  { text: PER_NOTE_MARKINGS_REFERENCE, cache: true },
  { text: TIES_REFERENCE, cache: true },
]

export interface RunGenerateBoundedInput {
  classification: Classification
  chatId: string
  /** Original user prompt — passed verbatim after the cached prefix. */
  userText: string
  /** Hard output ceiling (policy.maxOutputTokens); defaults to BOUNDED_EMIT_CEILING. */
  maxOutputTokens?: number
  modelOverride?: string
  apiKeyOverride?: string
}

export async function runGenerateBounded(
  input: RunGenerateBoundedInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()

  // Soft per-session guard — wires the otherwise-dead exceedsBudget(). Best-
  // effort only (the budget Map is process-local, resets on restart); the hard
  // per-request kill-switch is the max_tokens ceiling below.
  if (input.chatId && input.chatId !== 'anonymous' && exceedsBudget(input.chatId)) {
    throw new GenerateBoundedError('session_budget_exceeded')
  }

  // No Opus (user directive + cost): both tiers stay on the medium tier (Sonnet).
  const selected = selectProvider('medium', input.chatId)
  const result = await callWithScoreRetry(
    { ...selected, chatId: input.chatId },
    {
      systemPrompt: BOUNDED_SYSTEM_BLOCKS,
      userText: `${input.userText}\n\nEmit at most 4 bars (grand staff = both staves sharing those 4 measures, bar-aligned).`,
      maxTokens: input.maxOutputTokens ?? BOUNDED_EMIT_CEILING, // <-- the kill-switch
      maxRetries: 1, // a tight ceiling can't be satisfied by re-sending the same size
      effort: 'low',
      thinking: 'disabled',
      temperature: 0,
      modelOverride: input.modelOverride ?? selected.model,
      ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
    },
  )

  recordUsage(input.chatId, result.usage?.inputTokens, result.usage?.outputTokens)

  return {
    score: result.input,
    classification: input.classification,
    model: result.model,
    latencyMs: Date.now() - t0,
    toolUseId: result.toolUseId,
    introText: result.introText,
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
