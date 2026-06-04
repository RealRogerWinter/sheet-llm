import type { Score } from '@/lib/music/types'
import { recordUsage } from '../budget'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
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
import { classifyComposeApproach } from '../composeApproach'
import { isComposePatchDispatchEnabled } from '../flags'
import { runEditIntraMeasure } from './editIntraMeasure'

const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts)

export interface RunComposeInput {
  classification: Classification
  chatId: string
  /** Original user prompt — the model needs this verbatim to follow
   *  meter/key/style instructions the classifier doesn't surface. */
  userText: string
  editedScore?: Score
  /** Debug-only: force a different model id (overrides Opus/Sonnet budget selection). */
  modelOverride?: string
}

/**
 * Compose system prompt: counterpoint, harmonization, voice-leading,
 * melodic development given an existing line.
 *
 * Multi-block layout (role, MULTI_STAFF_REFERENCE shared with
 * generateComplex, then composer-specific guidance + copyright + per-
 * measure constraints).
 */
const COMPOSE_ROLE = `You are the composer for sheet-llm. The user provides an existing musical line and asks you to add counterpoint, harmonization, or voice-leading. Always emit via the render_score tool.`

const COMPOSE_GUIDANCE = `GUIDANCE:
- When asked for counterpoint, observe consonance / dissonance rules appropriate to the user's stated style (species counterpoint, free counterpoint, etc.). For independent contrapuntal lines, use \`extraVoices\` on the appropriate staff rather than chord stacks.
- When asked for harmonization, ensure chord changes align with the melody's strong beats. A chordal accompaniment that moves in block harmony belongs as chord stacks; an independent harmonized line belongs as a second voice.
- When asked for voice-leading, prefer stepwise motion and resolved leading tones.
- SATB or four-part requests use the multi-voice layout documented above.

COPYRIGHT SAFETY:
- Refuse verbatim reproduction of any copyrighted modern work.
- Style imitation is permitted ("in the style of Bach", "like a Renaissance motet").
- If the user's request implicitly asks for a famous copyrighted melody, produce ORIGINAL material in the requested style.
- Pre-1929 works and works by public-domain composers are unrestricted.

CONSTRAINTS:
- Each voice's measures must sum exactly to the meter, per measure.
- Use only the supported enums for pitch / duration / accidental.`

const COMPOSE_SYSTEM_BLOCKS: SystemBlock[] = [
  { text: COMPOSE_ROLE },
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
  { text: COMPOSE_GUIDANCE },
]

/** No-op kept for back-compat with any test still importing it. */
export function _resetComposeClient(): void {}

/**
 * Compose entry point with Lever B sub-classifier dispatch.
 *
 * When the feature flag is on AND an `editedScore` is in context, a
 * cheap Haiku-tier classifier decides whether the request is patchable
 * (route to `runEditIntraMeasure`) or needs full regeneration (stay on
 * the existing render_score path). The dispatch is a no-op when the
 * flag is off or no editedScore is present — preserving the prior
 * behavior bit-for-bit.
 *
 * On any sub-classifier failure (provider error, parse failure) the
 * approach defaults to `'regen'` so the user always gets a response on
 * the unchanged path.
 */
export async function runCompose(input: RunComposeInput): Promise<OrchestratorResult> {
  // Deprecated path: when the M3.5 native tool-use dispatcher is enabled
  // (default since PR-6), the orchestrator routes compose-shaped requests
  // through the dispatcher's `regenerate_all` branch, so the
  // `SL_COMPOSE_PATCH_DISPATCH` sub-classifier is unreachable in practice.
  // The branch is retained for opt-out users running with
  // `SL_NEW_TOOL_DISPATCH=0`. See flags.ts for the deprecation note.
  if (input.editedScore && isComposePatchDispatchEnabled()) {
    const approach = await classifyComposeApproach({
      userText: input.userText,
      editedScore: input.editedScore,
      chatId: input.chatId,
    })
    if (approach === 'patch') {
      const editResult = await runEditIntraMeasure({
        classification: {
          ...input.classification,
          // editIntraMeasure expects target_description; pass the user's
          // full request so the medium-tier model authoring the ops has
          // the full compositional intent, not just the classifier's
          // gist.
          target_description: input.userText,
        },
        editedScore: input.editedScore,
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
      })
      // summarizeAction switches on classification.kind. The work that
      // actually fired was an intra-measure edit; tag it so the route's
      // confirmation text matches what happened rather than what the
      // top-level classifier originally decided.
      return {
        ...editResult,
        classification: { ...editResult.classification, kind: 'edit_intra_measure' as const },
        composePatchDispatch: 'patch' as const,
      }
    }
    return runComposeAsRegen(input, 'regen')
  }
  return runComposeAsRegen(input, 'skipped')
}

async function runComposeAsRegen(
  input: RunComposeInput,
  dispatchOutcome: 'regen' | 'skipped',
): Promise<OrchestratorResult> {
  const t0 = Date.now()

  // No Opus (user directive + cost): compose runs on the medium tier
  // (Sonnet). Debug modelOverride still wins.
  const selected = selectProvider('medium', input.chatId)
  const effectiveModel = input.modelOverride ?? selected.model

  const userText = input.editedScore
    ? `${input.userText}\n\nCURRENT SCORE (JSON):\n${JSON.stringify(input.editedScore, null, 2)}`
    : input.userText

  const result = await callWithScoreRetry(
    { ...selected, chatId: input.chatId },
    {
      systemPrompt: COMPOSE_SYSTEM_BLOCKS,
      userText,
      maxTokens: MAX_TOKENS,
      modelOverride: effectiveModel,
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
    composePatchDispatch: dispatchOutcome,
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
