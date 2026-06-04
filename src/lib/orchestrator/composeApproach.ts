import { z } from 'zod'
import type { Score } from '@/lib/music/types'
import { getMeasureCount } from '@/lib/music/scoreAccessors'
import { selectProvider } from '@/lib/providers/select'
import { callWithFailover } from '@/lib/providers/callWithFailover'

/**
 * Sub-classifier fired by `runCompose` when an `editedScore` is present.
 * Decides whether the compose request is expressible as `edit_score`
 * patch operations against the existing score (cheap medium-tier call,
 * no full regeneration) or whether it needs full re-authoring (compose
 * regenerates via `render_score`).
 *
 * Off by default — gated by `SL_COMPOSE_PATCH_DISPATCH=1` in
 * `flags.ts#isComposePatchDispatchEnabled`. When the flag is off OR
 * `editedScore` is absent, `runCompose` keeps its prior behavior and
 * this module is never reached.
 *
 * Conservative defaults: any classifier failure (provider error, parse
 * failure, schema mismatch) returns `'regen'`. The behavior under
 * failure matches the pre-Lever-B path exactly.
 */

const ComposeApproachSchema = z.object({
  decision: z.enum(['patch', 'regen']),
})

type ComposeApproachInput = z.infer<typeof ComposeApproachSchema>

const COMPOSE_APPROACH_TOOL = {
  name: 'classify_compose_approach',
  description:
    'Decide whether the compose request is expressible as a small set of edit_score patch operations against the existing score, or requires full regeneration via render_score.',
  inputSchema: ComposeApproachSchema,
  inputSchemaJson: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['decision'],
    properties: {
      decision: { type: 'string', enum: ['patch', 'regen'] },
    },
  },
}

const COMPOSE_APPROACH_PROMPT = `You triage compose requests for an existing musical score. Your single output is one of two decisions: "patch" or "regen".

Pick "patch" when the user's request can be fulfilled by a small sequence of operations applied to the existing score:
- changePitch (transpose a note up/down by step or octave)
- changeDuration (lengthen/shorten a note)
- setAccidental / setArticulation (modify a note's spelling or marking)
- toggleTie
- deleteEvent / insertEventAfter (remove or add a note at a specific position)
- addPitchToChord / removePitchFromChord (modify the harmony of an existing event)
- reorderEvent (swap adjacent events)
- changeKey / changeMeter / changeTempo / changeTitle / changeClef (score-level metadata)
- insertMeasureAfter / deleteMeasure / duplicateMeasure (whole-measure structural changes)

Pick "regen" when the request needs full re-authoring:
- Adding a new independent voice or counterpoint line (the patch language cannot create new voices from scratch)
- Adding a new staff (e.g. piano left hand to a single-staff score)
- Replacing the melody or structurally rewriting the piece
- Stylistic transformations that touch most events ("make it sound like Bach", "jazzify the whole thing")
- Requests where the user describes the desired end-state rather than the change ("write a development section")

When in doubt, prefer "regen" — a wasted regeneration is recoverable; a botched patch is harder to interpret.

Examples:
- "raise the third note an octave" → patch
- "add a fermata to the last note" → patch
- "change measure 4 to triplets" → patch
- "harmonize each note with a C-E-G chord stack" → patch (addPitchToChord on each event)
- "transpose the whole thing up a step" → patch (changePitch on every event)
- "switch to D major" → patch
- "add a bass line counterpoint" → regen (needs new voice)
- "harmonize with an independent alto line" → regen (needs new voice)
- "rewrite this in the style of Mozart" → regen
- "add a development section" → regen
- "fix the parallel fifths in measure 3" → patch (a few changePitch ops)

Reply only via the classify_compose_approach tool. Do not include explanatory text.`

/**
 * Ask a small-tier model (Haiku by default) whether the current compose
 * request is patchable. Returns `'regen'` on any failure so the calling
 * path falls back to the existing render_score behavior unchanged.
 *
 * The model sees a one-line score summary (measure count + key + meter),
 * not the full Score JSON — this keeps the call cheap (≤ ~400 tokens)
 * and avoids paying for the same JSON twice (the downstream handler
 * already includes it in its own prompt).
 */
export async function classifyComposeApproach(args: {
  userText: string
  editedScore: Score
  chatId?: string
}): Promise<'patch' | 'regen'> {
  const summary = `${getMeasureCount(args.editedScore)} measures, key=${args.editedScore.key}, meter=${args.editedScore.meter}`
  const selected = selectProvider('small', args.chatId)
  try {
    const result = await callWithFailover<ComposeApproachInput>(
      { ...selected, chatId: args.chatId },
      COMPOSE_APPROACH_TOOL,
      {
        systemPrompt: COMPOSE_APPROACH_PROMPT,
        userText: `Existing score: ${summary}\n\nUser asked: ${args.userText}`,
        toolChoice: 'required',
        maxTokens: 50,
        temperature: 0,
        // The provider defaults to Sonnet when modelOverride is absent;
        // explicitly forward the selected (small-tier = Haiku) model so
        // the sub-classifier stays on the cheap tier.
        modelOverride: selected.model,
        providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
      },
    )
    return result.input.decision
  } catch {
    return 'regen'
  }
}

export const __TEST_COMPOSE_APPROACH_PROMPT = COMPOSE_APPROACH_PROMPT
