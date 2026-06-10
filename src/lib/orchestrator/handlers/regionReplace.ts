import { z } from 'zod'
import type { Score, Event, Measure } from '@/lib/music/types'
import { MeasureSchema } from '@/lib/music/types'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import { detectSeveredSpans } from '@/lib/music/structuralOps'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError, type ProviderToolResult } from '@/lib/providers/types'
import { STAFF_MEASURE_PROPERTIES } from '@/lib/llm/renderScoreTool'

/**
 * H2 helper — detect ties that cross the region-replace boundary:
 *
 *  - Tie INTO the region: the event immediately BEFORE startMeasureIdx
 *    (last event of measure startMeasureIdx-1) has tied_to_next (event-
 *    wide or per-pitch). The corresponding "next event" was the first
 *    event of the original measure at startMeasureIdx — now replaced.
 *    The replacement's first event MAY satisfy the tie if step+octave
 *    match; otherwise the tie is silently broken — we clear the flag
 *    and warn.
 *
 *  - Tie OUT of the region: the LAST event of the LAST measure of the
 *    replaced original range has tied_to_next. Since that event is
 *    DELETED, the tie has no source after replacement; nothing to do
 *    structurally, but warn that the user's original tie semantics
 *    were lost.
 */
export function detectAndResolveBoundaryTies(
  beforeScore: Score,
  startMeasureIdx: number,
  endMeasureIdx: number,
  emittedMeasures: Measure[],
): { workingScore: Score; warnings: string[] } {
  const warnings: string[] = []
  let workingScore = beforeScore

  // Tie INTO the region: clear unmatched tied_to_next on the event
  // immediately before the region.
  if (startMeasureIdx > 0) {
    const prevMeasure = workingScore.measures[startMeasureIdx - 1]
    if (prevMeasure && prevMeasure.events.length > 0) {
      const prevEv = prevMeasure.events[prevMeasure.events.length - 1]
      const evTied = prevEv.tied_to_next === true
      const perPitchTied: number[] = []
      prevEv.pitches.forEach((p, i) => {
        if (p.tied_to_next === true) perPitchTied.push(i)
      })
      if (evTied || perPitchTied.length > 0) {
        const firstNew = emittedMeasures[0]?.events?.[0]
        const eventLevelMatch = !!firstNew && (() => {
          const a = lowestStepOctave(prevEv)
          const b = lowestStepOctave(firstNew)
          return !!(a && b && a.step === b.step && a.octave === b.octave)
        })()
        const unmatchedPerPitch: number[] = []
        for (const pi of perPitchTied) {
          const p = prevEv.pitches[pi]
          if (p.step === 'rest') {
            unmatchedPerPitch.push(pi)
            continue
          }
          const match = !!firstNew?.pitches.some(
            (np) => np.step === p.step && np.octave === p.octave,
          )
          if (!match) unmatchedPerPitch.push(pi)
        }
        const clearEvent = evTied && !eventLevelMatch
        if (clearEvent || unmatchedPerPitch.length > 0) {
          workingScore = clearTiesOnEvent(
            workingScore,
            startMeasureIdx - 1,
            prevMeasure.events.length - 1,
            clearEvent,
            unmatchedPerPitch,
          )
          warnings.push(
            `Tie at measure ${startMeasureIdx - 1} event ${prevMeasure.events.length - 1} cleared because regionReplace broke the connection (the replacement's first event does not match the tied pitch).`,
          )
        }
      }
    }
  }

  // Tie OUT of the region: the LAST event of the LAST replaced measure
  // had tied_to_next → the source of the tie is being deleted. Warn so
  // the user knows the original semantics were lost. No structural
  // action needed; the event is gone with the rest of the range.
  const lastReplacedMeasure = workingScore.measures[endMeasureIdx]
  if (lastReplacedMeasure && lastReplacedMeasure.events.length > 0) {
    const lastEv = lastReplacedMeasure.events[lastReplacedMeasure.events.length - 1]
    const anyTie =
      lastEv.tied_to_next === true ||
      lastEv.pitches.some((p) => p.tied_to_next === true)
    if (anyTie) {
      // If the replacement's last event AND the post-region first event
      // happen to align by pitch, the user could re-establish the tie
      // manually — but we don't auto-mint that. Just warn.
      warnings.push(
        `Tie at measure ${endMeasureIdx} (last event of replaced range) was lost because regionReplace removed the source event.`,
      )
    }
  }

  return { workingScore, warnings }
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

function clearTiesOnEvent(
  score: Score,
  measureIdx: number,
  eventIdx: number,
  clearEventTie: boolean,
  clearPerPitchIndices: number[],
): Score {
  const m = score.measures[measureIdx]
  if (!m) return score
  const ev = m.events[eventIdx]
  if (!ev) return score
  let nextEv: Event = ev
  if (clearEventTie && ev.tied_to_next) {
    const { tied_to_next: _drop, ...rest } = nextEv
    void _drop
    nextEv = rest as Event
  }
  if (clearPerPitchIndices.length > 0) {
    const drops = new Set(clearPerPitchIndices)
    nextEv = {
      ...nextEv,
      pitches: nextEv.pitches.map((p, i) => {
        if (!drops.has(i)) return p
        if (p.tied_to_next === undefined) return p
        const { tied_to_next: _drop, ...rest } = p
        void _drop
        return rest
      }),
    }
  }
  const newEvents = [...m.events]
  newEvents[eventIdx] = nextEv
  const newMeasures = [...score.measures]
  newMeasures[measureIdx] = { ...m, events: newEvents }
  return { ...score, measures: newMeasures }
}

/**
 * region_replace handler (M3.5-PR-3) — replace a contiguous run of
 * measures with new content. Same emit-tool pattern; the
 * `transformScore('regionReplace')` op handles fanout, span cleanup,
 * and index remap.
 *
 * Severed-span warning: when a span's start lives inside the replaced
 * range but its end lives outside (or vice-versa), surface a warning
 * naming the span ids. The span itself is dropped automatically.
 */

const REGION_TOOL_NAME = 'emit_replacement_bars'
const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts)

export class RegionReplaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegionReplaceError'
  }
}

export interface RunRegionReplaceInput {
  classification: Classification
  editedScore: Score
  userText: string
  startMeasureIdx: number
  endMeasureIdx: number
  hint?: string
  chatId?: string
  modelOverride?: string
  apiKeyOverride?: string
}

const EmitReplacementBarsSchema = z.object({
  measures: z.array(MeasureSchema).min(1).max(128),
  perVoiceContent: z
    .array(z.object({ voices: z.array(z.array(MeasureSchema)) }))
    .optional(),
})

// The model-facing JSON schema for ONE measure. Reuses the SAME detailed event
// shape as render_score (STAFF_MEASURE_PROPERTIES: pitches[step/octave/accidental]
// + duration + markings) so the model knows what an event is. The old stub
// (`events: { items: { type: 'object' } }`) told the model nothing, so it emitted
// skeletal events and every one failed the strict MeasureSchema with
// "pitches: expected array, received undefined".
const MEASURE_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: STAFF_MEASURE_PROPERTIES,
} as const

export const REGION_SYSTEM_PROMPT = `You are REPLACING a contiguous run of measures in an existing score with new content. The user has supplied a Score and asks you to rewrite a specific range.

CRITICAL RULES:
1. You do NOT emit a new Score. You emit only the REPLACEMENT measures.
2. The score's key, meter, clef, title, and tempo are SET — you cannot change them.
3. The new measures inherit the score's key, meter, and clef.
4. Use the measures BEFORE the range and AFTER the range as compositional context — voice-lead naturally across the splice.
5. Single-staff scores emit only "measures"; grand-staff scores may supply "perVoiceContent" for each staff/voice.
6. Do NOT include text — the tool call IS your response.
`

function buildRegionPrompt(
  input: RunRegionReplaceInput,
  validationFeedback?: string,
): string {
  const score = input.editedScore
  const ctxStart = Math.max(0, input.startMeasureIdx - 2)
  const ctxEnd = Math.min(score.measures.length, input.endMeasureIdx + 3)
  const window = score.measures.slice(ctxStart, ctxEnd)
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
    `REPLACE RANGE: [${input.startMeasureIdx}..${input.endMeasureIdx}] (inclusive, 0-based)`,
    ...(input.hint ? [`HINT: ${input.hint}`] : []),
    '',
    `SCORE METADATA (set; do NOT re-emit):`,
    `  title=${JSON.stringify(score.title ?? null)}`,
    `  key=${score.key}`,
    `  meter=${score.meter}`,
    `  measures total=${score.measures.length}`,
    '',
    `CONTEXT WINDOW (indices ${ctxStart}..${ctxEnd - 1}):`,
    JSON.stringify(window, null, 2),
    '',
    'FULL EXISTING SCORE (do NOT re-emit; only the replacement bars):',
    JSON.stringify(score, null, 2),
  ]
  return lines.join('\n')
}

export async function runRegionReplace(
  input: RunRegionReplaceInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  if (!input.editedScore) {
    throw new RegionReplaceError('region_replace requires a current score')
  }
  const measureCount = input.editedScore.measures.length
  if (
    input.startMeasureIdx < 0 ||
    input.endMeasureIdx >= measureCount ||
    input.startMeasureIdx > input.endMeasureIdx
  ) {
    throw new RegionReplaceError(
      `range [${input.startMeasureIdx}..${input.endMeasureIdx}] invalid; score has ${measureCount} measures`,
    )
  }

  // Detect severed spans BEFORE applying so we can warn with the
  // original span ids (the op drops them).
  const severed = detectSeveredSpans(
    input.editedScore,
    input.startMeasureIdx,
    input.endMeasureIdx,
  )

  // SHE-19: edit handlers default to Haiku; complexity escalates to Sonnet.
  const selected = selectProvider(
    resolveModelClass({ callType: 'edit', complexity: input.classification.complexity }),
    input.chatId,
  )

  // Validation-retry loop (M3.5-PR-5b): re-prompt once on ValidationError
  // with the failure message threaded into the user text.
  let toolResult!: ProviderToolResult<z.infer<typeof EmitReplacementBarsSchema>>
  let nextScore!: Score
  let op!: Operation
  const countMismatchWarnings: string[] = []
  let tieBoundaryWarnings: string[] = []
  let lastValidationError: string | undefined
  let attempt = 0
  while (true) {
    attempt++
    try {
      toolResult = await callWithFailover<z.infer<typeof EmitReplacementBarsSchema>>(
        { ...selected, chatId: input.chatId },
        {
          name: REGION_TOOL_NAME,
          description:
            'Emit ONLY the replacement measures for the given range. Do not emit key, meter, clef, title, or tempo.',
          inputSchema: EmitReplacementBarsSchema,
          inputSchemaJson: {
            type: 'object',
            additionalProperties: false,
            required: ['measures'],
            properties: {
              measures: {
                type: 'array',
                minItems: 1,
                maxItems: 128,
                description:
                  'Replacement measures for the PRIMARY staff. Each measure has an events array of {pitches:[{step,octave,accidental}], duration, ...} — same event shape as render_score. For a rest, use a single pitch with step:"rest".',
                items: MEASURE_JSON,
              },
              perVoiceContent: {
                type: 'array',
                description:
                  'Grand-staff / multi-voice content. One entry per staff (entry 0 = primary, entry 1 = second staff). Each entry has voices: an array (one per voice) of measure arrays. Use this to write the LEFT-HAND (bass-clef, second-staff) part — its measures use the SAME event shape as above.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['voices'],
                  properties: {
                    voices: {
                      type: 'array',
                      items: { type: 'array', items: MEASURE_JSON },
                    },
                  },
                },
              },
            },
          },
        },
        {
          systemPrompt: REGION_SYSTEM_PROMPT,
          userText: buildRegionPrompt(input, lastValidationError),
          toolChoice: 'required',
          maxTokens: MAX_TOKENS,
          temperature: 0,
          modelOverride: input.modelOverride ?? selected.model,
          ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
          providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
        },
      )
    } catch (e) {
      if (e instanceof ProviderSchemaError) {
        throw new RegionReplaceError(`region_replace: ${e.message}`)
      }
      throw e
    }

    const emittedMeasures = toolResult.input.measures
    const perVoiceContent = toolResult.input.perVoiceContent

    // H4 — emit-count info. Region replace accepts the emitted length as
    // the actual replacement length; warn so the user notices.
    const requestedLen = input.endMeasureIdx - input.startMeasureIdx + 1
    countMismatchWarnings.length = 0
    if (emittedMeasures.length !== requestedLen) {
      countMismatchWarnings.push(
        `LLM emitted ${emittedMeasures.length} measure${emittedMeasures.length === 1 ? '' : 's'}; requested ${requestedLen} (range [${input.startMeasureIdx}..${input.endMeasureIdx}]). Using all emitted measures as the replacement length.`,
      )
    }

    // H2 — detect and resolve ties crossing the replacement boundary.
    const tieBoundary = detectAndResolveBoundaryTies(
      input.editedScore,
      input.startMeasureIdx,
      input.endMeasureIdx,
      emittedMeasures,
    )
    const workingScore = tieBoundary.workingScore
    tieBoundaryWarnings = tieBoundary.warnings

    op = {
      kind: 'regionReplace',
      startMeasureIdx: input.startMeasureIdx,
      endMeasureIdx: input.endMeasureIdx,
      measures: emittedMeasures,
      ...(perVoiceContent !== undefined ? { perVoiceContent } : {}),
    }

    try {
      nextScore = transformScore(workingScore, op)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      throw new RegionReplaceError(`region_replace apply failed: ${msg}`)
    }

    try {
      validateScore(nextScore)
      if (attempt > 1 && process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
        console.warn(
          `[handler retry attempt=${attempt} succeeded] region_replace recovered after validation feedback`,
        )
      }
      break
    } catch (e) {
      if (e instanceof ValidationError && attempt < 2) {
        lastValidationError = e.message
        if (process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
          console.warn(
            `[handler retry] region_replace attempt=${attempt} validation failed: ${e.message.slice(0, 200)} — retrying with feedback`,
          )
        }
        continue
      }
      if (e instanceof ValidationError) {
        throw new RegionReplaceError(
          `region_replace produced an invalid score: ${e.message}`,
        )
      }
      throw e
    }
  }

  const warnings: string[] = []
  warnings.push(...countMismatchWarnings)
  warnings.push(...tieBoundaryWarnings)
  for (const id of severed) {
    warnings.push(
      `Span ${id} was severed by region-replace; you may need to redraw it.`,
    )
  }

  // H3 — surface dropped jumpMarkers. transformScore's regionReplace
  // arm internally invokes remapScoreReferences which drops jumpMarkers
  // whose segnoRef/codaRef/toCodaRef no longer resolves. Compare
  // before vs after to emit a warning per dropped entry.
  const beforeJumpIds = new Set(
    (input.editedScore.jumpMarkers ?? []).map((j) => j.id),
  )
  const afterJumpIds = new Set((nextScore.jumpMarkers ?? []).map((j) => j.id))
  for (const j of input.editedScore.jumpMarkers ?? []) {
    if (beforeJumpIds.has(j.id) && !afterJumpIds.has(j.id)) {
      // Only warn for the dangling-ref case — entries dropped purely
      // because their measureIdx landed inside the deleted range are
      // expected (no surprise to the user that deleting a D.S.'s bar
      // removes the D.S.).
      const segnoIds = new Set((nextScore.segnoMarkers ?? []).map((s) => s.id))
      const codaIds = new Set((nextScore.codaMarkers ?? []).map((c) => c.id))
      const danglingSegno = j.segnoRef !== undefined && !segnoIds.has(j.segnoRef)
      const danglingCoda = j.codaRef !== undefined && !codaIds.has(j.codaRef)
      const danglingToCoda = j.toCodaRef !== undefined && !codaIds.has(j.toCodaRef)
      if (danglingSegno || danglingCoda || danglingToCoda) {
        const refs: string[] = []
        if (danglingSegno) refs.push(`segnoRef=${j.segnoRef}`)
        if (danglingCoda) refs.push(`codaRef=${j.codaRef}`)
        if (danglingToCoda) refs.push(`toCodaRef=${j.toCodaRef}`)
        warnings.push(
          `JumpMarker ${j.id} (${j.kind}) was dropped because region-replace removed its target: ${refs.join(', ')}.`,
        )
      }
    }
  }

  return {
    score: nextScore,
    classification: input.classification,
    model: toolResult.model,
    latencyMs: Date.now() - t0,
    toolUseId: toolResult.toolUseId,
    introText: toolResult.introText,
    appliedOps: [op],
    ...(warnings.length > 0 ? { warnings } : {}),
    dispatchTool: 'region_replace' as const,
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
