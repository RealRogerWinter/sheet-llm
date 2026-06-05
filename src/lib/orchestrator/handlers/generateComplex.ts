import { recordUsage } from '../budget'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import {
  ANNOTATIONS_REFERENCE,
  BARLINES_REFERENCE,
  CHORD_SYMBOLS_REFERENCE,
  FINGERINGS_REFERENCE,
  JUMP_MARKERS_REFERENCE,
  LYRICS_REFERENCE,
  MARKERS_REFERENCE,
  MULTI_STAFF_REFERENCE,
  PER_NOTE_MARKINGS_REFERENCE,
  TECHNIQUE_STATES_REFERENCE,
  TIES_REFERENCE,
  VOLTAS_REFERENCE,
} from '@/lib/llm/systemPrompt'
import type { SystemBlock } from '@/lib/providers/types'
import { callWithScoreRetry } from './scoreRetry'

const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts)

export interface RunGenerateComplexInput {
  classification: Classification
  chatId: string
  /** Original user prompt — the model needs this verbatim to honor
   *  meter/key/style instructions the classifier doesn't surface. */
  userText: string
  /** Debug-only: force a different model id (defaults to large tier). */
  modelOverride?: string
  /** PR-8: route this whole-score emit to Opus (`large` tier). Set only for a
   *  resolved Advanced paid Pro turn; see modelClass.ts. */
  advancedComposer?: boolean
}

/**
 * Multi-block system layout: role first (small, handler-specific),
 * MULTI_STAFF_REFERENCE second (large, shared cache across handlers),
 * constraints third. Anthropic's per-block cache_control means the
 * middle block is reused with generateComplex / compose in the same
 * session.
 */
const COMPLEX_ROLE = `You are the complex-generation handler for sheet-llm. You generate long-form pieces, multi-voice melodic lines, ornamented passages, style imitation, and dense rhythmic content. Always emit via the render_score tool.`

const COMPLEX_CONSTRAINTS = `CONSTRAINTS for complex generation:
- Each measure's durations must sum exactly to the meter (no overflow or underflow). When you emit multiple voices on the same staff, every voice's measure must independently sum to the meter.
- Use the supported pitch / duration / accidental / articulation enums.
- For piano / grand-staff / SATB requests, use the multi-staff schema fields documented above. Do NOT collapse multiple voices into chord stacks when the user asks for independent lines.
- Refuse verbatim reproduction of any copyrighted modern work. Style imitation ("in the style of <genre or PD composer>") is allowed.
- Pre-1929 works and all public-domain composers (Bach, Mozart, etc.) are unrestricted.`

const COMPLEX_SYSTEM_BLOCKS: SystemBlock[] = [
  { text: COMPLEX_ROLE },
  { text: MULTI_STAFF_REFERENCE, cache: true },
  { text: PER_NOTE_MARKINGS_REFERENCE, cache: true },
  { text: TECHNIQUE_STATES_REFERENCE, cache: true },
  { text: FINGERINGS_REFERENCE, cache: true },
  { text: ANNOTATIONS_REFERENCE, cache: true },
  { text: MARKERS_REFERENCE, cache: true },
  { text: CHORD_SYMBOLS_REFERENCE, cache: true },
  { text: TIES_REFERENCE, cache: true },
  { text: LYRICS_REFERENCE, cache: true },
  { text: BARLINES_REFERENCE, cache: true },
  { text: VOLTAS_REFERENCE, cache: true },
  { text: JUMP_MARKERS_REFERENCE, cache: true },
  { text: COMPLEX_CONSTRAINTS },
]

/** No-op kept for back-compat with any test still importing it. */
export function _resetGenerateComplexClient(): void {}

export async function runGenerateComplex(
  input: RunGenerateComplexInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  // PR-8: Standard routes to the medium tier (Sonnet); an Advanced paid Pro turn
  // routes this whole-score emit to Opus (`large`). Debug modelOverride still wins.
  const selected = selectProvider(
    resolveModelClass({ advancedComposer: input.advancedComposer, callType: 'whole_score' }),
    input.chatId,
  )
  const result = await callWithScoreRetry(
    { ...selected, chatId: input.chatId },
    {
      systemPrompt: COMPLEX_SYSTEM_BLOCKS,
      userText: input.userText,
      maxTokens: MAX_TOKENS,
      modelOverride: input.modelOverride ?? selected.model,
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
