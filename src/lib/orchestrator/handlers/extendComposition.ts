import { z } from 'zod'
import type { Score, Measure, Span, Event } from '@/lib/music/types'
import { MeasureSchema } from '@/lib/music/types'
import { STAFF_MEASURE_PROPERTIES } from '@/lib/llm/renderScoreTool'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import { verifyAllOriginalsPreserved } from '../preservationVerifier'
import { detectCadenceAtFinalBarline } from '@/lib/music/cadenceDetect'
import { createSpanId } from '@/lib/music/spans'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError, type ProviderToolResult } from '@/lib/providers/types'

/**
 * extend_composition handler (M3.5-PR-3) — the heart of the silent-
 * replacement bug fix.
 *
 * Contract:
 *  - Inputs: classification, editedScore, userText, targetBars, hint?
 *  - The handler builds a dedicated extend prompt that:
 *      1. Includes the full existing score JSON for context
 *      2. Injects the trailing 4 bars verbatim as compositional context
 *      3. Tells the LLM to emit ONLY the new bars (count = targetBars)
 *      4. FORBIDS re-emission of score-level metadata via the schema
 *  - Uses a dedicated `emit_appended_bars` tool that has NO top-level
 *    key/meter/clef/title/tempo fields — making mis-emission impossible
 *    structurally rather than relying on prompt discipline.
 *  - Server-side measure-hash verification confirms every original
 *    measure is byte-identical post-application. Mismatches degrade
 *    to a warning (PR-3) or refuse-and-confirm (PR-4 onward) on
 *    second failure.
 *  - Tie-at-boundary auto-downgrade to slur when the first new event's
 *    lowest pitch doesn't match.
 *  - Cadence-at-boundary detection emits a warn-only signal.
 */

const EXTEND_TOOL_NAME = 'emit_appended_bars'
const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts)

export class ExtendCompositionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtendCompositionError'
  }
}

export interface RunExtendCompositionInput {
  classification: Classification
  editedScore: Score
  userText: string
  targetBars: number
  hint?: string
  chatId?: string
  modelOverride?: string
  apiKeyOverride?: string
  /** Per-call output ceiling. Defaults to MAX_TOKENS. The sectional
   *  generator (M25) raises this so a grand-staff section has headroom. */
  maxTokens?: number
  /** PR-8: route this extend to Opus (`large` tier). Set only for a resolved
   *  Advanced paid Pro turn on the STANDALONE extend path — the sectional
   *  generator's internal extends deliberately leave this unset (Sonnet-tuned).
   *  See modelClass.ts. */
  advancedComposer?: boolean
}

const EmitAppendedBarsSchema = z.object({
  measures: z.array(MeasureSchema).min(1).max(64),
  /** Optional per-voice content for grand-staff extension. Mirrors
   *  PerVoiceMeasures in structuralOps.ts. When omitted, secondStaff
   *  / extraVoices get rest measures (handled by the op). */
  perVoiceContent: z
    .array(z.object({ voices: z.array(z.array(MeasureSchema)) }))
    .optional(),
})

export const EXTEND_SYSTEM_PROMPT = `You are EXTENDING an existing musical score by APPENDING new measures to the end. The user has supplied a Score and asks you to add N more bars.

CRITICAL RULES:
1. You do NOT emit a new Score. You emit only the NEW measures.
2. The score's key, meter, clef, title, and tempo are SET. They CANNOT change. Your tool input has no fields for them — emitting them is impossible.
3. The new measures inherit the score's key, meter, and clef. Use the SAME meter (sum to the exact bar capacity per measure). Use the SAME key (no transposition unless the user explicitly says so).
4. Use the trailing measures of the EXISTING score (provided below) as compositional context. Build on what's already there — voice-lead naturally from the last event(s); don't start over.
5. If the user's prompt asks for a chord progression, harmony, or turnaround (i-iv-V, V-I, etc.), translate the chord roots into actual pitched events whose lowest note is the chord root in the score's key.
6. Author the new bars in the same VOICE as the existing primary staff. Single-staff scores emit only "measures"; grand-staff scores may supply "perVoiceContent" for each staff/voice.
7. Do NOT include text — the tool call IS your response.

OUTPUT:
- Emit a single "emit_appended_bars" tool call.
- "measures": an array of exactly the requested number of new bars. Each measure has "events" whose durations sum to the meter.
- "perVoiceContent" (optional): when the score has secondStaff or extraVoices, supply matching content per (staffIdx, voiceIdx). When omitted, those voices receive rest measures.

EXAMPLE (4-bar C-major score extension by 4 bars with a i-iv-V turnaround prompt):
Existing score: C major, 4/4, 4 bars of ascending triplets.
The user wants 4 more bars with a "i iv v turnaround".
"i" is C minor (or C major for an interpolated progression), "iv" is F minor (or F major), "v" is G minor (or G major).
In C MAJOR we'd typically read "i iv v" loosely as I-IV-V, ending on V to set up a return — or as a 4-bar phrase with one chord per bar.
Tool call:
{
  "measures": [
    { "events": [{ "pitches": [{"step":"C","octave":4}], "duration":"whole" }] },
    { "events": [{ "pitches": [{"step":"F","octave":4}], "duration":"whole" }] },
    { "events": [{ "pitches": [{"step":"G","octave":4}], "duration":"whole" }] },
    { "events": [{ "pitches": [{"step":"C","octave":4}], "duration":"whole" }] }
  ]
}
(Each whole-note in 4/4 — the simplest valid emission. A musical author may use richer rhythms; the only hard constraint is duration summing to the meter.)

CONSTRAINTS:
- Each measure's event durations must sum exactly to the meter capacity (4/4 → 8 eighths, 3/4 → 6 eighths, etc.). Triplets multiply the base by 2/3.
- Pitch step ∈ {C,D,E,F,G,A,B}; octave 0..9 (middle C = C4; a bass-clef / funk-bass line sits at octave 1-2); rest events use step="rest".
- Duration ∈ {whole, half, quarter, eighth, sixteenth, 32nd, dotted-half, dotted-quarter, dotted-eighth}.
`

function buildExtendPrompt(
  input: RunExtendCompositionInput,
  validationFeedback?: string,
): string {
  const score = input.editedScore
  const trailingCount = Math.min(4, score.measures.length)
  const trailing = score.measures.slice(score.measures.length - trailingCount)
  const lines: string[] = [
    `USER REQUEST: ${input.userText}`,
    ...(validationFeedback
      ? [
          '',
          'YOUR PREVIOUS ATTEMPT FAILED VALIDATION:',
          validationFeedback,
          '',
          "Fix the issue and emit again. Pay close attention to per-measure duration sums matching the score's meter (e.g. 4/4 = 8 eighths per measure).",
        ]
      : []),
    `TARGET BARS TO APPEND: ${input.targetBars}`,
    ...(input.hint ? [`HINT: ${input.hint}`] : []),
    '',
    `SCORE METADATA (set; do NOT re-emit; these are GIVEN, not for you to change):`,
    `  title=${JSON.stringify(score.title ?? null)}`,
    `  key=${score.key}`,
    `  meter=${score.meter}`,
    `  clef=${score.clef ?? 'treble'}`,
    `  tempo_bpm=${score.tempo_bpm ?? 'unset'}`,
    `  measures total=${score.measures.length}`,
    `  staves=${score.secondStaff ? 2 : 1}`,
    '',
    `TRAILING ${trailingCount} BAR${trailingCount === 1 ? '' : 'S'} OF THE EXISTING SCORE (use as compositional context; do not emit these):`,
    JSON.stringify(trailing, null, 2),
  ]
  // M26 PR-3 — input cap: extend only APPENDS bars after the existing score, so
  // it needs the trailing window + metadata, NOT the whole score. Dropping the
  // full-score dump is the dominant per-turn input saving on a large score; the
  // metadata summary above covers far-reference context.
  return lines.join('\n')
}

/**
 * Apply tie-at-boundary handling: if the LAST event of the existing
 * score has any tie to next (event-level OR per-pitch), check whether
 * the FIRST new event satisfies each tie. Mismatched ties auto-
 * downgrade to slurs.
 *
 * Semantics:
 *   - Event-level `tied_to_next`: tie holds when the lowest pitch of
 *     the last event matches the lowest pitch of the first new event.
 *   - Per-pitch `tied_to_next` on Pitch (M1-PR-3 / #81): each tied
 *     pitch must find a step+octave match among the first new event's
 *     pitches. Per-pitch ties without a match are individually
 *     downgraded — the per-pitch flag is cleared and an event-level
 *     slur span is added from lastEvent.id → firstNewEvent.id.
 *     (Our schema has no per-pitch slur; the event-level slur covers
 *     the typical voice-leading case — abcjs renders the curve
 *     between the lowest pitches.)
 *
 * Returns (a) modifications to apply to the score's final event
 * (clearing event-level tied_to_next, clearing per-pitch flags), (b)
 * any slur spans to add, and (c) warning string(s).
 */
export interface TieBoundaryResult {
  newMeasures: Measure[]
  spansToAdd: Span[]
  warnings: string[]
  /** Whether the caller must strip event-level tied_to_next on the
   *  final original event (because the event-level tie was unmatched). */
  clearEventTie: boolean
  /** Indices of pitches on the final original event whose per-pitch
   *  tied_to_next flag the caller must clear. */
  clearPerPitchIndices: number[]
}

const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function lowestStepOctave(ev: Event): { step: string; octave: number } | null {
  let best: { step: string; octave: number; midi: number } | null = null
  for (const p of ev.pitches) {
    if (p.step === 'rest') continue
    const midi = (p.octave + 1) * 12 + (STEP_SEMI[p.step] ?? 0)
    if (best === null || midi < best.midi) best = { step: p.step, octave: p.octave, midi }
  }
  return best ? { step: best.step, octave: best.octave } : null
}

export function handleTieBoundary(score: Score, newMeasures: Measure[]): TieBoundaryResult {
  const empty: TieBoundaryResult = {
    newMeasures,
    spansToAdd: [],
    warnings: [],
    clearEventTie: false,
    clearPerPitchIndices: [],
  }
  if (score.measures.length === 0 || newMeasures.length === 0) return empty
  const lastExistingMeasure = score.measures[score.measures.length - 1]
  if (!lastExistingMeasure || lastExistingMeasure.events.length === 0) return empty
  const lastEvent = lastExistingMeasure.events[lastExistingMeasure.events.length - 1]
  const firstNewMeasure = newMeasures[0]
  if (firstNewMeasure.events.length === 0) return empty
  const firstNewEvent = firstNewMeasure.events[0]

  const eventLevelTied = lastEvent.tied_to_next === true
  const perPitchTiedIdxs: number[] = []
  lastEvent.pitches.forEach((p, i) => {
    if (p.tied_to_next === true) perPitchTiedIdxs.push(i)
  })
  if (!eventLevelTied && perPitchTiedIdxs.length === 0) return empty

  const spansToAdd: Span[] = []
  const warnings: string[] = []
  let clearEventTie = false
  const clearPerPitchIndices: number[] = []

  // ── Event-level tie check ────────────────────────────────────────
  if (eventLevelTied) {
    const a = lowestStepOctave(lastEvent)
    const b = lowestStepOctave(firstNewEvent)
    const matched = !!(a && b && a.step === b.step && a.octave === b.octave)
    if (!matched) {
      clearEventTie = true
      if (lastEvent.id && firstNewEvent.id) {
        spansToAdd.push({
          id: createSpanId(),
          kind: 'slur',
          startEventId: lastEvent.id,
          endEventId: firstNewEvent.id,
          staffIdx: 0,
          voiceIdx: 0,
        })
      }
      warnings.push(
        "Tie at the boundary downgraded to a slur — the first new event's pitch does not match the last existing event.",
      )
    }
  }

  // ── Per-pitch tie checks (M1-PR-3 #81) ────────────────────────────
  // For each pitch with `tied_to_next === true` on the last existing
  // event, look up a matching step+octave among the first new event's
  // pitches. Keep matches; downgrade unmatched ties to an event-level
  // slur span (no per-pitch slur exists in our schema; an event-level
  // slur from lastEvent.id → firstNewEvent.id is the closest faithful
  // rendering — abcjs draws the curve between the lowest pitches).
  let needPerPitchSlur = false
  for (const pi of perPitchTiedIdxs) {
    const p = lastEvent.pitches[pi]
    if (p.step === 'rest') {
      // Defensive — a rest can't tie. Just clear it.
      clearPerPitchIndices.push(pi)
      continue
    }
    const match = firstNewEvent.pitches.some(
      (np) => np.step === p.step && np.octave === p.octave,
    )
    if (!match) {
      clearPerPitchIndices.push(pi)
      needPerPitchSlur = true
    }
  }
  if (needPerPitchSlur) {
    // Only add a slur if we haven't already added one from the event-
    // level tie downgrade; both downgrades map to the same span.
    if (spansToAdd.length === 0 && lastEvent.id && firstNewEvent.id) {
      spansToAdd.push({
        id: createSpanId(),
        kind: 'slur',
        startEventId: lastEvent.id,
        endEventId: firstNewEvent.id,
        staffIdx: 0,
        voiceIdx: 0,
      })
    }
    warnings.push(
      'Per-pitch tie at the boundary downgraded to an event-level slur — one or more tied pitches do not have a matching step+octave in the first new event. (Our schema has no per-pitch slur.)',
    )
  }

  return {
    newMeasures,
    spansToAdd,
    warnings,
    clearEventTie,
    clearPerPitchIndices,
  }
}

/**
 * Apply tie clears returned by handleTieBoundary to the score's final
 * event: drop event-level tied_to_next if requested, clear per-pitch
 * tied_to_next on the listed indices. Pure / immutable.
 */
export function applyFinalTieClears(
  score: Score,
  clearEventTie: boolean,
  clearPerPitchIndices: number[],
): Score {
  if (!clearEventTie && clearPerPitchIndices.length === 0) return score
  if (score.measures.length === 0) return score
  const lastMi = score.measures.length - 1
  const last = score.measures[lastMi]
  if (!last.events.length) return score
  const lastEi = last.events.length - 1
  const lastEv = last.events[lastEi]

  let nextEv: Event = lastEv
  if (clearEventTie && lastEv.tied_to_next) {
    const { tied_to_next: _drop, ...rest } = nextEv
    void _drop
    nextEv = rest as Event
  }
  if (clearPerPitchIndices.length > 0) {
    const drops = new Set(clearPerPitchIndices)
    const newPitches = nextEv.pitches.map((p, i) => {
      if (!drops.has(i)) return p
      if (p.tied_to_next === undefined) return p
      const { tied_to_next: _drop, ...rest } = p
      void _drop
      return rest
    })
    nextEv = { ...nextEv, pitches: newPitches }
  }
  const newEvents = [...last.events]
  newEvents[lastEi] = nextEv
  const newMeasures = [...score.measures]
  newMeasures[lastMi] = { ...last, events: newEvents }
  return { ...score, measures: newMeasures }
}

/**
 * Detect metadata-claim violations: the tool schema has no top-level
 * key/meter/title/tempo fields, but if the LLM somehow puts them
 * INSIDE a measure object or invents new top-level keys via additional
 * properties (zod's permissive default), we surface that as an error.
 *
 * Since MeasureSchema is closed via .strip() and Measure has no
 * key/meter/title/tempo fields, the schema parse itself rejects them
 * — but we double-check the tool output's top-level keys to be safe.
 */
function detectMetadataClaim(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const top = raw as Record<string, unknown>
  const allowed = new Set(['measures', 'perVoiceContent'])
  for (const k of Object.keys(top)) {
    if (!allowed.has(k)) {
      return `tool input included disallowed top-level field "${k}"; only measures/perVoiceContent are permitted`
    }
  }
  return null
}

export async function runExtendComposition(
  input: RunExtendCompositionInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  if (!input.editedScore) {
    throw new ExtendCompositionError(
      'extend_composition requires a current score; none was sent with the request',
    )
  }
  if (input.targetBars < 1 || input.targetBars > 64) {
    throw new ExtendCompositionError(
      `targetBars must be in [1..64] (got ${input.targetBars})`,
    )
  }

  // PR-8: Standard extends on the medium tier (Sonnet); an Advanced paid Pro
  // turn routes a standalone extend to Opus (`large`). The sectional generator's
  // internal extends never set `advancedComposer`, so they stay Sonnet.
  // SHE-19: complexity threads from the classification so simple extends default to Haiku.
  const selected = selectProvider(
    resolveModelClass({ advancedComposer: input.advancedComposer, callType: 'extend', complexity: input.classification.complexity }),
    input.chatId,
  )

  // Validation-retry loop (M3.5-PR-5b): when the LLM emits measures
  // whose durations don't sum to the meter, validateScore throws —
  // re-prompt once with the failure message threaded back. Only retry
  // on ValidationError; ProviderSchemaError (malformed tool input) and
  // UpstreamError (already handled by callWithFailover) fall through.
  let toolResult!: ProviderToolResult<z.infer<typeof EmitAppendedBarsSchema>>
  let nextScore!: Score
  let tieResult!: TieBoundaryResult
  let workingScore!: Score
  let cadence!: ReturnType<typeof detectCadenceAtFinalBarline>
  let cadenceWarn: string | undefined
  const countMismatchWarnings: string[] = []
  let lastValidationError: string | undefined
  let attempt = 0
  while (true) {
    attempt++
    try {
      toolResult = await callWithFailover<z.infer<typeof EmitAppendedBarsSchema>>(
        { ...selected, chatId: input.chatId },
        {
          name: EXTEND_TOOL_NAME,
          description:
            'Emit ONLY the new measures to append to the end of the existing score. Do not emit key, meter, clef, title, or tempo — those are inherited.',
          inputSchema: EmitAppendedBarsSchema,
          inputSchemaJson: {
            type: 'object',
            additionalProperties: false,
            required: ['measures'],
            properties: {
              measures: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['events'],
                  // Full event/pitch schema (shared with render_score) so the
                  // model emits well-formed events. The old opaque
                  // `events: { items: { type: 'object' } }` left the model to
                  // guess the shape, so a dense bar's ~20 events came back
                  // without a `pitches` array and the strict Zod parse
                  // rejected every one ("expected array, received undefined").
                  properties: STAFF_MEASURE_PROPERTIES,
                },
              },
              perVoiceContent: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['voices'],
                  properties: {
                    voices: {
                      type: 'array',
                      items: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['events'],
                          properties: STAFF_MEASURE_PROPERTIES,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          systemPrompt: EXTEND_SYSTEM_PROMPT,
          userText: buildExtendPrompt(input, lastValidationError),
          toolChoice: 'required',
          maxTokens: input.maxTokens ?? MAX_TOKENS,
          temperature: 0,
          modelOverride: input.modelOverride ?? selected.model,
          ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
          providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
        },
      )
    } catch (e) {
      if (e instanceof ProviderSchemaError) {
        throw new ExtendCompositionError(`extend_composition: ${e.message}`)
      }
      throw e
    }

    const metadataErr = detectMetadataClaim(toolResult.input)
    if (metadataErr) {
      throw new ExtendCompositionError(`extend_composition: ${metadataErr}`)
    }

    const emittedMeasures = toolResult.input.measures
    // Reset per-attempt collected warnings (they're rebuilt on each iter).
    countMismatchWarnings.length = 0
    if (emittedMeasures.length !== input.targetBars) {
      // H4: surface a warning so the user knows the LLM didn't honor the
      // requested count. Warn-and-keep — accepting the LLM's output is the
      // PR-3 ethos; PR-future can swap to strict-retry.
      countMismatchWarnings.push(
        `LLM emitted ${emittedMeasures.length} measure${emittedMeasures.length === 1 ? '' : 's'}; requested ${input.targetBars}. Using all emitted measures.`,
      )
    }

    // Apply boundary handling BEFORE the structural op so the score we
    // mutate has the tie(s) cleared (if downgrade fires).
    workingScore = input.editedScore
    tieResult = handleTieBoundary(workingScore, emittedMeasures)
    workingScore = applyFinalTieClears(
      workingScore,
      tieResult.clearEventTie,
      tieResult.clearPerPitchIndices,
    )

    // Detect cadence at boundary BEFORE applying.
    cadence = detectCadenceAtFinalBarline(workingScore)
    cadenceWarn =
      cadence.detected && (cadence.kind === 'authentic' || cadence.kind === 'plagal')
        ? `Appended bars splice past what looks like a ${cadence.kind} cadence (${cadence.kind === 'authentic' ? 'V→I' : 'IV→I'}) at the final barline; consider whether this is intentional.`
        : undefined

    const perVoiceContent = toolResult.input.perVoiceContent
    const op: Operation = {
      kind: 'appendMeasures',
      measures: emittedMeasures,
      ...(perVoiceContent !== undefined ? { perVoiceContent } : {}),
    }

    try {
      nextScore = transformScore(workingScore, op)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      throw new ExtendCompositionError(`extend_composition apply failed: ${msg}`)
    }

    // Merge the tie-downgrade slur span(s) (if any) into the new score.
    if (tieResult.spansToAdd.length > 0) {
      const existing = nextScore.spans ?? []
      nextScore = { ...nextScore, spans: [...existing, ...tieResult.spansToAdd] }
    }

    // Validate.
    try {
      validateScore(nextScore)
      if (attempt > 1 && process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
        console.warn(
          `[handler retry attempt=${attempt} succeeded] extend_composition recovered after validation feedback`,
        )
      }
      break
    } catch (e) {
      if (e instanceof ValidationError && attempt < 2) {
        lastValidationError = e.message
        if (process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
          console.warn(
            `[handler retry] extend_composition attempt=${attempt} validation failed: ${e.message.slice(0, 200)} — retrying with feedback`,
          )
        }
        continue
      }
      if (e instanceof ValidationError) {
        throw new ExtendCompositionError(
          `extend_composition produced an invalid score: ${e.message}`,
        )
      }
      throw e
    }
  }
  // Reconstruct the applied op for the result payload (last iteration's
  // op is captured implicitly via emittedMeasures + perVoiceContent).
  const finalEmittedMeasures = toolResult.input.measures
  const finalPerVoiceContent = toolResult.input.perVoiceContent
  const op: Operation = {
    kind: 'appendMeasures',
    measures: finalEmittedMeasures,
    ...(finalPerVoiceContent !== undefined ? { perVoiceContent: finalPerVoiceContent } : {}),
  }

  // Server-side hash verification — confirm every original measure is
  // byte-identical post-application. The tie-strip we may have applied
  // changes the LAST original measure's hash (we removed tied_to_next);
  // exclude that bar from the verify if a tie warning fired.
  const warnings: string[] = []
  warnings.push(...countMismatchWarnings)
  warnings.push(...tieResult.warnings)
  if (cadenceWarn) warnings.push(cadenceWarn)
  const tieDowngradeFired =
    tieResult.clearEventTie || tieResult.clearPerPitchIndices.length > 0

  const originalCount = input.editedScore.measures.length
  const claimedRetained =
    tieDowngradeFired && originalCount > 0
      ? Array.from({ length: originalCount - 1 }, (_, i) => i)
      : Array.from({ length: originalCount }, (_, i) => i)
  // Verify against the workingScore (after potential tie-strip), since
  // that's what the op was applied to.
  const verify = verifyAllOriginalsPreserved(
    {
      ...workingScore,
      measures: workingScore.measures.slice(0, originalCount),
    },
    {
      ...nextScore,
      measures: nextScore.measures.slice(0, originalCount),
    },
  )
  void claimedRetained // (full-original verify suffices when no tie-strip happens)
  if (!verify.ok) {
    warnings.push(
      `Preservation verification flagged ${verify.mismatches.length} original measure${verify.mismatches.length === 1 ? '' : 's'} as modified: [${verify.mismatches.join(', ')}]. Accepting with warning; future PRs will surface a confirmation gate.`,
    )
  }

  return {
    score: nextScore,
    classification: input.classification,
    model: toolResult.model,
    latencyMs: Date.now() - t0,
    toolUseId: toolResult.toolUseId,
    introText: toolResult.introText,
    appliedOps: [op],
    // SHE-18 PR3 — surface the preservation-verify result so recordTurn can
    // persist it (pass/fail + how many original measures diverged).
    preservation: { ok: verify.ok, mismatchCount: verify.mismatches.length },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(cadence.detected && (cadence.kind === 'authentic' || cadence.kind === 'plagal')
      ? { cadenceAtBoundary: true }
      : {}),
    dispatchTool: 'extend_composition' as const,
    ...(toolResult.usage
      ? {
          usage: {
            inputTokens: toolResult.usage.inputTokens,
            outputTokens: toolResult.usage.outputTokens,
            cachedInputTokens: toolResult.usage.cachedInputTokens,
          },
        }
      : {}),
  }
}
