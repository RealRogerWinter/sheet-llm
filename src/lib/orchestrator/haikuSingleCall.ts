/**
 * SHE-19 PR2 — free-tier single-call collapse (production).
 *
 * Collapses the orchestrator's 2-call EDIT path (toolDispatch picks one of the
 * structural actions, then a dedicated handler makes a SECOND LLM call to author
 * the precise operations) into ONE Haiku `tool_choice:'auto'` call that BOTH
 * picks the action AND emits the final operations. Exposes the five structural
 * emit-tools with their EXACT existing schemas (region/insert additionally carry
 * the dispatch range fields so the model emits them inline). Under 'auto', a
 * plain-TEXT reply IS the answer_question / converse case.
 *
 * APPROACH (2) HYBRID: the unified system prompt carries the dispatcher's
 * DECISION RULES *plus each action's FULL focused emit guidance* (the real
 * EXTEND/REGION/INSERT/INTRA prompts + compose guidance) — not diluted
 * one-liners. This closes the `turnaround-after-PAC` cadence-quality regression
 * the diluted spike showed, by preserving the extend handler's cadence/ending
 * guidance verbatim.
 *
 * Anthropic-only by design (the call relies on reliable native tool-use under
 * `tool_choice:'auto'`, which only `AnthropicProvider.multiToolCall` provides).
 * A non-Anthropic resolved provider throws `MultiToolUnsupportedError`; the
 * call site in `index.ts` logs it and falls back to the 2-call dispatch path.
 *
 * Gated by `isHaikuSingleCallEnabled()` (default OFF) AND `getGenerationTier()
 * === 'free'` at the call site. The result flows through the SAME
 * `finalizeDispatchResult` seam the 2-call path uses, so the measure-hash
 * preservation check and replacement-as-confirmation gate apply unchanged.
 */
import { z } from 'zod'
import type { Score, Span } from '@/lib/music/types'
import { MeasureSchema, ScoreSchema } from '@/lib/music/types'
import {
  STAFF_MEASURE_PROPERTIES,
  renderScoreTool,
  RENDER_SCORE_TOOL_NAME,
} from '@/lib/llm/renderScoreTool'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import { detectCadenceAtFinalBarline } from '@/lib/music/cadenceDetect'
import { detectSeveredSpans } from '@/lib/music/structuralOps'
import { ensureAnnotationIds } from '@/lib/music/annotations'
import { ensureMarkerIds } from '@/lib/music/markers'
import {
  ensureCodaMarkerIds,
  ensureJumpMarkerIds,
  ensureSegnoMarkerIds,
  ensureSpanIds,
  ensureVoltaIds,
} from '@/lib/music/spans'
import { ensureTechniqueIds } from '@/lib/music/techniques'
import { verifyAllOriginalsPreserved } from './preservationVerifier'
import { buildEditScoreSchemaJson, INTRA_SYSTEM_PROMPT } from './handlers/editIntraMeasure'
import {
  EXTEND_SYSTEM_PROMPT,
  handleTieBoundary,
  applyFinalTieClears,
} from './handlers/extendComposition'
import { REGION_SYSTEM_PROMPT, detectAndResolveBoundaryTies } from './handlers/regionReplace'
import { INSERT_SYSTEM_PROMPT } from './handlers/insertMeasures'
import { COMPOSE_ROLE, COMPOSE_GUIDANCE } from './handlers/compose'
import { selectProvider } from '@/lib/providers/select'
import { AnthropicProvider } from '@/lib/providers/anthropic'
import {
  MultiToolUnsupportedError,
  type MultiToolResult,
  type ProviderTool,
  type ProviderUsage,
} from '@/lib/providers/types'
import type { Classification, OrchestratorResult } from './types'

// ── Tool names (mirror the handlers verbatim) ────────────────────────────────
const EDIT_TOOL_NAME = 'edit_score'
const EXTEND_TOOL_NAME = 'emit_appended_bars'
const INSERT_TOOL_NAME = 'emit_inserted_bars'
const REGION_TOOL_NAME = 'emit_replacement_bars'

// ── Per-tool zod schemas (mirror the handlers; insert/region carry the range
//    fields the dispatcher would otherwise pick separately) ───────────────────
const EditScoreInputSchema = z.object({ ops: z.array(z.unknown()) })

const EmitAppendedBarsSchema = z.object({
  measures: z.array(MeasureSchema).min(1).max(64),
  perVoiceContent: z
    .array(z.object({ voices: z.array(z.array(MeasureSchema)) }))
    .optional(),
})

const EmitInsertedBarsSchema = z.object({
  afterMeasureIdx: z.number().int().min(-1),
  measures: z.array(MeasureSchema).min(1).max(64),
  perVoiceContent: z
    .array(z.object({ voices: z.array(z.array(MeasureSchema)) }))
    .optional(),
})

const EmitReplacementBarsSchema = z.object({
  startMeasureIdx: z.number().int().min(0),
  endMeasureIdx: z.number().int().min(0),
  measures: z.array(MeasureSchema).min(1).max(128),
  perVoiceContent: z
    .array(z.object({ voices: z.array(z.array(MeasureSchema)) }))
    .optional(),
})

const MEASURE_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: STAFF_MEASURE_PROPERTIES,
} as const

const PER_VOICE_JSON = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['voices'],
    properties: {
      voices: { type: 'array', items: { type: 'array', items: MEASURE_JSON } },
    },
  },
} as const

const MAX_TOKENS = 8_000

export class HaikuSingleCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HaikuSingleCallError'
  }
}

export interface RunHaikuSingleCallInput {
  userText: string
  editedScore: Score
  chatId?: string
  modelOverride?: string
  apiKeyOverride?: string
}

/**
 * Unified system prompt (approach (2) HYBRID). Three parts:
 *   1. WHICH action when — the dispatcher's DECISION RULES.
 *   2. The prose escape — a pure question gets a text reply, no tool.
 *   3. Each action's FULL focused emit guidance, verbatim from the handler that
 *      owns it (so e.g. the extend section keeps its cadence/ending guidance —
 *      the regression the diluted spike opened). Because Haiku caches the static
 *      system prefix, embedding the full guidance is near-free turn-over-turn.
 */
let _unifiedSystemPrompt: string | undefined
/**
 * Build the unified prompt once, lazily, and memoize. Lazy (not a module-level
 * const) so the embedded handler prompts are read at FIRST CALL, not at import
 * — the prompts are static, so this is a one-time cost, and it keeps module load
 * free of cross-handler evaluation.
 */
function unifiedSystemPrompt(): string {
  if (_unifiedSystemPrompt !== undefined) return _unifiedSystemPrompt
  _unifiedSystemPrompt = [
  `You are the unified editor for sheet-llm. The user has an existing musical score and made a request. In ONE step you must BOTH decide the right action AND emit the FINAL operations for it — there is no second call.`,
  ``,
  `You have FIVE structural tools plus a prose escape:`,
  `1. edit_score({ ops }) — SURGICAL edits: change/add/remove specific notes, articulations, dynamics, ornaments, barlines, markers. Emit the minimal Operation array directly.`,
  `2. emit_appended_bars({ measures, perVoiceContent? }) — ADD measures to the END ("add N more bars", "extend", "continue", "keep going", "add a coda/tag"). Emit ONLY the new bars; key/meter/clef/title/tempo are inherited.`,
  `3. emit_inserted_bars({ afterMeasureIdx, measures, perVoiceContent? }) — INSERT bars into the MIDDLE ("insert N bars after measure 3"). afterMeasureIdx is 0-based; -1 = before bar 1. Emit ONLY the new bars.`,
  `4. emit_replacement_bars({ startMeasureIdx, endMeasureIdx, measures, perVoiceContent? }) — REWRITE a contiguous run of bars ("rewrite measures 5-8", "fix the bridge"), OR enrich a RANGE of existing bars ("add a bass line to bars 5-8" → replace that range, writing the new line INTO the existing staff). Range is inclusive, 0-based (bar 5 = index 4). Emit ONLY the replacement bars.`,
  `5. render_score(<full Score>) — ONLY when the user EXPLICITLY asked to throw the score away and start over ("start over", "scrap this and write X", "rewrite from scratch"). Emit a complete new Score.`,
  ``,
  `DECISION RULES (which action when):`,
  `- "add N bars" / "add a coda" / "extend" / "continue" / "keep going" → emit_appended_bars. NOT render_score, EVEN IF the user describes the new content in detail.`,
  `- "add a bass line / inner voice / harmony / left-hand part" to a RANGE of existing bars → emit_replacement_bars over that range (the score already has its staves; write into the existing staff — do NOT append empty bars, do NOT add a staff).`,
  `- "change" / "fix" / "rewrite" + a SPECIFIC range → emit_replacement_bars or edit_score.`,
  `- "raise the third note", "add a fermata", "make beat 3 staccato" → edit_score.`,
  `- "start over" / "scrap" / "throw away" → render_score (only here).`,
  `- When in doubt between appending and rewriting the whole score, prefer appending — a wasted append is cheap; a silent wholesale replacement of the user's work is the bug we avoid.`,
  ``,
  `If the user is only ASKING A QUESTION about the score (music theory, analysis, "what key is this", "name the chord", "why does this resolve") and wants an EXPLANATION, reply in PROSE and do NOT call a tool. A request phrased as a hypothetical edit ("what if you made it minor?", "can you add a coda?") is NOT a question — call the matching tool.`,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call emit_appended_bars, follow this guidance exactly:`,
  EXTEND_SYSTEM_PROMPT,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call emit_replacement_bars, follow this guidance exactly:`,
  REGION_SYSTEM_PROMPT,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call emit_inserted_bars, follow this guidance exactly:`,
  INSERT_SYSTEM_PROMPT,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call edit_score, follow the op vocabulary exactly:`,
  INTRA_SYSTEM_PROMPT,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call render_score (full rewrite only), follow this guidance:`,
  COMPOSE_ROLE,
  COMPOSE_GUIDANCE,
  ].join('\n')
  return _unifiedSystemPrompt
}

function mapUsage(u?: ProviderUsage): OrchestratorResult['usage'] | undefined {
  if (!u) return undefined
  return {
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u.cachedInputTokens !== undefined ? { cachedInputTokens: u.cachedInputTokens } : {}),
  }
}

/**
 * Build the request user text: the prompt + a compact score summary (tail
 * window) + the full score JSON (so the model can place edits precisely). Mirror
 * the dispatcher's summary so the model sees the same boundary context.
 */
function buildScoreSummary(score: Score): string {
  const measureCount = score.measures.length
  const staffCount = score.secondStaff ? 2 : 1
  const tail = score.measures.slice(Math.max(0, measureCount - 4))
  const tailSummary = tail
    .map((m, i) => {
      const start = measureCount - tail.length + i
      const notes = m.events
        .map((e) => {
          if (e.pitches.length === 0) return '-'
          const p = e.pitches[0]
          if (p.step === 'rest') return `R(${e.duration})`
          return `${p.step}${p.octave}(${e.duration})`
        })
        .join(' ')
      return `  m${start}: ${notes}`
    })
    .join('\n')
  return [
    `Score summary:`,
    `  title: ${score.title ?? '(untitled)'}`,
    `  key: ${score.key}`,
    `  meter: ${score.meter}`,
    `  tempo_bpm: ${score.tempo_bpm ?? 'unset'}`,
    `  measures: ${measureCount}`,
    `  staves: ${staffCount}`,
    `Last ${tail.length} bar${tail.length === 1 ? '' : 's'} (notation: pitch(duration)):`,
    tailSummary || '  (none)',
    '',
    'FULL EXISTING SCORE (JSON):',
    JSON.stringify(score, null, 2),
  ].join('\n')
}

/** A synthetic Classification for the result envelope — matches what
 *  runDispatchedHandler builds (kind maps loosely to the action). */
function classificationFor(kind: Classification['kind'], confidence = 0.85): Classification {
  return { kind, scope: 'short', complexity: 'complex', confidence }
}

/** Backfill ids on a regenerate_all Score exactly as scoreRetry does. */
function backfillIds(score: Score): Score {
  ensureTechniqueIds(score)
  ensureAnnotationIds(score)
  ensureMarkerIds(score)
  ensureSpanIds(score)
  ensureVoltaIds(score)
  ensureJumpMarkerIds(score)
  ensureSegnoMarkerIds(score)
  ensureCodaMarkerIds(score)
  return score
}

/** The five emit-tools with their EXACT schemas; insert/region add the range
 *  fields so the model emits them inline (no separate dispatch). */
function buildTools(score: Score): Array<ProviderTool<unknown>> {
  return [
    {
      name: EDIT_TOOL_NAME,
      description:
        'Surgical intra-measure edits. Emit the minimal Operation array under "ops".',
      inputSchema: EditScoreInputSchema as unknown as ProviderTool<unknown>['inputSchema'],
      inputSchemaJson: buildEditScoreSchemaJson(score),
    },
    {
      name: EXTEND_TOOL_NAME,
      description:
        'Emit ONLY the new measures to append to the END. Do not emit key/meter/clef/title/tempo.',
      inputSchema: EmitAppendedBarsSchema as unknown as ProviderTool<unknown>['inputSchema'],
      inputSchemaJson: {
        type: 'object',
        additionalProperties: false,
        required: ['measures'],
        properties: {
          measures: { type: 'array', minItems: 1, maxItems: 64, items: MEASURE_JSON },
          perVoiceContent: PER_VOICE_JSON,
        },
      },
    },
    {
      name: INSERT_TOOL_NAME,
      description:
        'Emit the new measures to INSERT plus "afterMeasureIdx" (0-based; -1 = before bar 1).',
      inputSchema: EmitInsertedBarsSchema as unknown as ProviderTool<unknown>['inputSchema'],
      inputSchemaJson: {
        type: 'object',
        additionalProperties: false,
        required: ['afterMeasureIdx', 'measures'],
        properties: {
          afterMeasureIdx: {
            type: 'integer',
            minimum: -1,
            description: '0-based bar to insert AFTER (-1 = before bar 1).',
          },
          measures: { type: 'array', minItems: 1, maxItems: 64, items: MEASURE_JSON },
          perVoiceContent: PER_VOICE_JSON,
        },
      },
    },
    {
      name: REGION_TOOL_NAME,
      description:
        'Emit the replacement measures plus the inclusive 0-based range "startMeasureIdx"/"endMeasureIdx".',
      inputSchema: EmitReplacementBarsSchema as unknown as ProviderTool<unknown>['inputSchema'],
      inputSchemaJson: {
        type: 'object',
        additionalProperties: false,
        required: ['startMeasureIdx', 'endMeasureIdx', 'measures'],
        properties: {
          startMeasureIdx: {
            type: 'integer',
            minimum: 0,
            description: 'First bar of the range to rewrite (0-based; bar 5 = index 4).',
          },
          endMeasureIdx: {
            type: 'integer',
            minimum: 0,
            description: 'Last bar of the range, INCLUSIVE (0-based; bar 8 = index 7).',
          },
          measures: { type: 'array', minItems: 1, maxItems: 128, items: MEASURE_JSON },
          perVoiceContent: PER_VOICE_JSON,
        },
      },
    },
    {
      name: RENDER_SCORE_TOOL_NAME,
      description:
        'Emit a COMPLETE new Score. Use ONLY when the user explicitly asked to start over.',
      inputSchema: ScoreSchema as unknown as ProviderTool<unknown>['inputSchema'],
      inputSchemaJson: renderScoreTool.input_schema as unknown as Record<string, unknown>,
    },
  ]
}

/**
 * Apply an emitted EXTEND (`emit_appended_bars`) WITH the extend handler's
 * warning recovery: tie-at-boundary auto-downgrade (reuse handleTieBoundary /
 * applyFinalTieClears), V-I cadence-at-boundary detection, count-mismatch
 * notice, and server-side preservation verify. Returns the result fields so the
 * single-call output is graded on the same invariants as the 2-call extend.
 */
function applyExtend(
  score: Score,
  parsed: z.infer<typeof EmitAppendedBarsSchema>,
): {
  score: Score
  appliedOps: Operation[]
  warnings: string[]
  cadenceAtBoundary: boolean
  preservation: { ok: boolean; mismatchCount: number }
} {
  const emittedMeasures = parsed.measures
  const warnings: string[] = []

  // Tie-boundary downgrade BEFORE the op, against the (potentially tie-stripped)
  // working score — same order the extend handler uses.
  let workingScore = score
  const tieResult = handleTieBoundary(workingScore, emittedMeasures)
  workingScore = applyFinalTieClears(
    workingScore,
    tieResult.clearEventTie,
    tieResult.clearPerPitchIndices,
  )
  warnings.push(...tieResult.warnings)

  // Cadence-at-boundary (warn-only) detection, BEFORE applying.
  const cadence = detectCadenceAtFinalBarline(workingScore)
  const cadenceAtBoundary =
    cadence.detected && (cadence.kind === 'authentic' || cadence.kind === 'plagal')
  if (cadenceAtBoundary) {
    warnings.push(
      `Appended bars splice past what looks like a ${cadence.kind} cadence (${cadence.kind === 'authentic' ? 'V→I' : 'IV→I'}) at the final barline; consider whether this is intentional.`,
    )
  }

  const op: Operation = {
    kind: 'appendMeasures',
    measures: emittedMeasures,
    ...(parsed.perVoiceContent !== undefined ? { perVoiceContent: parsed.perVoiceContent } : {}),
  }
  let next = transformScore(workingScore, op)

  // Merge tie-downgrade slur span(s) into the new score.
  if (tieResult.spansToAdd.length > 0) {
    const existing: Span[] = next.spans ?? []
    next = { ...next, spans: [...existing, ...tieResult.spansToAdd] }
  }

  validateScore(next)

  // Server-side preservation verify on the original-measure prefix (exclude the
  // last original bar when a tie-strip changed its hash).
  const originalCount = score.measures.length
  const verify = verifyAllOriginalsPreserved(
    { ...workingScore, measures: workingScore.measures.slice(0, originalCount) },
    { ...next, measures: next.measures.slice(0, originalCount) },
  )
  if (!verify.ok) {
    warnings.push(
      `Preservation verification flagged ${verify.mismatches.length} original measure${verify.mismatches.length === 1 ? '' : 's'} as modified: [${verify.mismatches.join(', ')}]. Accepting with warning.`,
    )
  }

  return {
    score: next,
    appliedOps: [op],
    warnings,
    cadenceAtBoundary,
    preservation: { ok: verify.ok, mismatchCount: verify.mismatches.length },
  }
}

/**
 * Apply an emitted REGION replace (`emit_replacement_bars`) WITH the region
 * handler's warning recovery: boundary-tie resolution (reuse
 * detectAndResolveBoundaryTies) and severed-span detection.
 */
function applyRegion(
  score: Score,
  parsed: z.infer<typeof EmitReplacementBarsSchema>,
): { score: Score; appliedOps: Operation[]; warnings: string[] } {
  const { startMeasureIdx, endMeasureIdx, measures } = parsed
  const measureCount = score.measures.length
  if (
    startMeasureIdx < 0 ||
    endMeasureIdx >= measureCount ||
    startMeasureIdx > endMeasureIdx
  ) {
    throw new HaikuSingleCallError(
      `emit_replacement_bars range [${startMeasureIdx}..${endMeasureIdx}] invalid; score has ${measureCount} measures`,
    )
  }

  const warnings: string[] = []
  // Severed spans BEFORE applying (the op drops them; we keep their ids to warn).
  const severed = detectSeveredSpans(score, startMeasureIdx, endMeasureIdx)

  // Boundary-tie resolution against the original score.
  const tieBoundary = detectAndResolveBoundaryTies(
    score,
    startMeasureIdx,
    endMeasureIdx,
    measures,
  )
  warnings.push(...tieBoundary.warnings)
  const workingScore = tieBoundary.workingScore

  const op: Operation = {
    kind: 'regionReplace',
    startMeasureIdx,
    endMeasureIdx,
    measures,
    ...(parsed.perVoiceContent !== undefined ? { perVoiceContent: parsed.perVoiceContent } : {}),
  }
  const next = transformScore(workingScore, op)
  validateScore(next)

  for (const id of severed) {
    warnings.push(`Span ${id} was severed by region-replace; you may need to redraw it.`)
  }

  return { score: next, appliedOps: [op], warnings }
}

export async function runHaikuSingleCall(
  input: RunHaikuSingleCallInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  const score = input.editedScore

  // Pin to Haiku (small tier). Reuse the existing provider selection so env /
  // sticky-per-chat still apply; the collapse is Anthropic-only — multiToolCall
  // lives on AnthropicProvider and is declared optional on the interface, so a
  // non-Anthropic provider (or any provider missing the method) throws a typed
  // error the caller catches and falls back on.
  const selected = selectProvider('small', input.chatId)
  if (!(selected.provider instanceof AnthropicProvider) || !selected.provider.multiToolCall) {
    throw new MultiToolUnsupportedError(
      `Haiku single-call collapse is Anthropic-only; resolved provider is ${selected.providerName}`,
    )
  }
  const provider = selected.provider
  const model = input.modelOverride ?? selected.model
  const tools = buildTools(score)

  // Validation-retry loop (mirrors the handlers): ONE retry. If apply /
  // validateScore throws a ValidationError on attempt 1, re-issue the SAME
  // multiToolCall with the failure threaded into the user text and re-apply. On
  // the 2nd failure — or any non-ValidationError — throw. The text/answer path
  // can't fail validation, so it returns without consuming a retry.
  const baseUserText = `${input.userText}\n\n${buildScoreSummary(score)}`
  let lastValidationError: string | undefined
  let attempt = 0
  while (true) {
    attempt++
    const userText =
      lastValidationError === undefined
        ? baseUserText
        : `${baseUserText}\n\nYour previous emission failed validation: ${lastValidationError}. Emit corrected operations.`

    const result: MultiToolResult = await provider.multiToolCall(tools, {
      systemPrompt: unifiedSystemPrompt(),
      userText,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      modelOverride: model,
      ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
      providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
    })

    // ── Prose reply → converse-style result (no score change) ────────────────
    if (result.kind === 'text') {
      return {
        score,
        introText: result.text,
        classification: classificationFor('converse'),
        model: result.model,
        latencyMs: Date.now() - t0,
        ...(mapUsage(result.usage) ? { usage: mapUsage(result.usage) } : {}),
      }
    }

    // ── Tool call → validate + apply the right transformScore kind ───────────
    const usage = mapUsage(result.usage)
    const base: Pick<OrchestratorResult, 'model' | 'toolUseId' | 'latencyMs'> = {
      model: result.model,
      toolUseId: result.toolUseId,
      latencyMs: Date.now() - t0,
    }

    try {
      switch (result.name) {
        case EDIT_TOOL_NAME: {
          const parsed = EditScoreInputSchema.safeParse(result.input)
          if (!parsed.success) {
            throw new HaikuSingleCallError(
              `edit_score args invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
            )
          }
          let next = score
          const applied: Operation[] = []
          for (const rawOp of parsed.data.ops) {
            const op = rawOp as Operation
            try {
              next = transformScore(next, op)
              applied.push(op)
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'unknown'
              throw new HaikuSingleCallError(`edit_score apply failed: ${msg}`)
            }
          }
          validateScore(next)
          return {
            ...base,
            score: next,
            classification: classificationFor('edit_intra_measure'),
            appliedOps: applied,
            dispatchTool: 'edit_intra_measure',
            ...(usage ? { usage } : {}),
          }
        }

        case EXTEND_TOOL_NAME: {
          const parsed = EmitAppendedBarsSchema.safeParse(result.input)
          if (!parsed.success) {
            throw new HaikuSingleCallError(
              `emit_appended_bars args invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
            )
          }
          const applied = applyExtend(score, parsed.data)
          return {
            ...base,
            score: applied.score,
            classification: classificationFor('compose'),
            appliedOps: applied.appliedOps,
            dispatchTool: 'extend_composition',
            preservation: applied.preservation,
            ...(applied.warnings.length > 0 ? { warnings: applied.warnings } : {}),
            ...(applied.cadenceAtBoundary ? { cadenceAtBoundary: true } : {}),
            ...(usage ? { usage } : {}),
          }
        }

        case INSERT_TOOL_NAME: {
          const parsed = EmitInsertedBarsSchema.safeParse(result.input)
          if (!parsed.success) {
            throw new HaikuSingleCallError(
              `emit_inserted_bars args invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
            )
          }
          const op: Operation = {
            kind: 'insertMeasuresAfter',
            afterMeasureIdx: parsed.data.afterMeasureIdx,
            measures: parsed.data.measures,
            ...(parsed.data.perVoiceContent !== undefined
              ? { perVoiceContent: parsed.data.perVoiceContent }
              : {}),
          }
          const next = transformScore(score, op)
          validateScore(next)
          return {
            ...base,
            score: next,
            classification: classificationFor('compose'),
            appliedOps: [op],
            dispatchTool: 'insert_measures',
            ...(usage ? { usage } : {}),
          }
        }

        case REGION_TOOL_NAME: {
          const parsed = EmitReplacementBarsSchema.safeParse(result.input)
          if (!parsed.success) {
            throw new HaikuSingleCallError(
              `emit_replacement_bars args invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
            )
          }
          const applied = applyRegion(score, parsed.data)
          return {
            ...base,
            score: applied.score,
            classification: classificationFor('compose'),
            appliedOps: applied.appliedOps,
            dispatchTool: 'region_replace',
            ...(applied.warnings.length > 0 ? { warnings: applied.warnings } : {}),
            ...(usage ? { usage } : {}),
          }
        }

        case RENDER_SCORE_TOOL_NAME: {
          const validated = validateScore(result.input)
          const next = backfillIds(validated)
          return {
            ...base,
            score: next,
            classification: classificationFor('compose'),
            dispatchTool: 'regenerate_all',
            ...(usage ? { usage } : {}),
          }
        }

        default:
          throw new HaikuSingleCallError(`model called an unknown tool "${result.name}"`)
      }
    } catch (e) {
      // One-shot validation-retry: a ValidationError on attempt 1 re-issues the
      // same call with the failure threaded into the user text. Apply errors are
      // rewrapped as HaikuSingleCallError and fall through (not retried).
      if (e instanceof ValidationError && attempt < 2) {
        lastValidationError = e.message
        continue
      }
      throw e
    }
  }
}
