/**
 * SHE-19 PR2 — free-tier single-call collapse (production).
 *
 * Collapses the orchestrator's 2-call EDIT path (toolDispatch picks one of the
 * structural actions, then a dedicated handler makes a SECOND LLM call to author
 * the precise operations) into ONE Haiku `tool_choice:'auto'` call that BOTH
 * picks the action AND emits the final operations. Exposes the FOUR structural
 * edit-tools (edit_score / emit_appended_bars / emit_inserted_bars /
 * emit_replacement_bars) with their EXACT existing schemas (region/insert
 * additionally carry the dispatch range fields so the model emits them inline).
 * Under 'auto', a plain-TEXT reply IS the answer_question / converse case.
 *
 * FREE-TIER ONLY (the call site gates on the per-request `useBoundedFallback`
 * policy signal). The wholesale `render_score` / `regenerate_all` rewrite is
 * Pro-only — it is deliberately NOT exposed here (a free user who asks to "start
 * over" routes to one of the edit tools or a full-range region_replace, which the
 * ratio-based replacement gate catches → confirmation fires). The free-tier bar
 * budget (`policy.maxBars`) and bounded output ceiling (`policy.emitCeiling`) are
 * enforced inside the apply, mirroring `runDispatchedHandler`. regenerate_all
 * stays Pro-only on the 2-call path.
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
 * Gated by `isHaikuSingleCallEnabled()` (default OFF) AND the per-request free
 * tier (`effectiveTierPolicy(input).useBoundedFallback`) at the call site. Only
 * the 4 structural edit tools are exposed — `render_score` (regenerate_all) is
 * Pro-only and stays on the 2-call path. The result flows through the SAME
 * `finalizeDispatchResult` seam the 2-call path uses, so the measure-hash
 * preservation check and replacement-as-confirmation gate apply unchanged.
 */
import { z } from 'zod'
import type { Score, Span } from '@/lib/music/types'
import { MeasureSchema } from '@/lib/music/types'
import { STAFF_MEASURE_PROPERTIES } from '@/lib/llm/renderScoreTool'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import { detectCadenceAtFinalBarline } from '@/lib/music/cadenceDetect'
import { detectSeveredSpans } from '@/lib/music/structuralOps'
import { verifyAllOriginalsPreserved } from './preservationVerifier'
import { buildEditScoreSchemaJson, INTRA_SYSTEM_PROMPT } from './handlers/editIntraMeasure'
import {
  EXTEND_SYSTEM_PROMPT,
  handleTieBoundary,
  applyFinalTieClears,
} from './handlers/extendComposition'
import { REGION_SYSTEM_PROMPT, detectAndResolveBoundaryTies } from './handlers/regionReplace'
import { INSERT_SYSTEM_PROMPT } from './handlers/insertMeasures'
import type { TierPolicy } from './types'
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

/**
 * Default Haiku model id (the `small`-tier Anthropic model) used when neither a
 * `modelOverride` nor a resolved provider model is supplied. Mirrors the
 * registry's small-tier id; the design pins this path to Haiku.
 */
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001'

/** Matches the 2-call EDIT handlers (region/extend/insert all use 8000). The
 *  free-tier edit bound is the BAR budget (maxBars), not an output-token cap —
 *  BOUNDED_EMIT_CEILING (2600) is the fresh-GENERATION limit, not an edit limit. */
const EDIT_MAX_TOKENS = 8_000

export class HaikuSingleCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HaikuSingleCallError'
  }
}

export interface RunHaikuSingleCallInput {
  userText: string
  editedScore: Score
  /**
   * The per-request resolved tier policy. The free-tier path enforces its scope
   * here: `maxBars` clamps extend/insert growth and `emitCeiling` bounds the
   * max_tokens output ceiling — mirroring `runDispatchedHandler`'s free clamps.
   * Required because this path runs ONLY on the free tier (the call site gates on
   * `useBoundedFallback`); a missing policy means the caller mis-wired the gate.
   */
  policy: TierPolicy
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
  `You have FOUR structural edit tools plus a prose escape:`,
  `1. edit_score({ ops }) — SURGICAL edits: change/add/remove specific notes, articulations, dynamics, ornaments, barlines, markers. Emit the minimal Operation array directly.`,
  `2. emit_appended_bars({ measures, perVoiceContent? }) — ADD measures to the END ("add N more bars", "extend", "continue", "keep going", "add a coda/tag"). Emit ONLY the new bars; key/meter/clef/title/tempo are inherited.`,
  `3. emit_inserted_bars({ afterMeasureIdx, measures, perVoiceContent? }) — INSERT bars into the MIDDLE ("insert N bars after measure 3"). afterMeasureIdx is 0-based; -1 = before bar 1. Emit ONLY the new bars.`,
  `4. emit_replacement_bars({ startMeasureIdx, endMeasureIdx, measures, perVoiceContent? }) — REWRITE a contiguous run of bars ("rewrite measures 5-8", "fix the bridge"), OR enrich a RANGE of existing bars ("add a bass line to bars 5-8" → replace that range, writing the new line INTO the existing staff). Range is inclusive, 0-based (bar 5 = index 4). Emit ONLY the replacement bars.`,
  ``,
  `There is NO "start over / rewrite from scratch" tool here — regenerating the whole score is unavailable on this path. A "start over" / "scrap this" request is served by rewriting the existing bars in place: use emit_replacement_bars over the FULL range of existing bars (startMeasureIdx 0 .. the last bar). Do not try to throw the score away.`,
  ``,
  `DECISION RULES (which action when):`,
  `- "add N bars" / "add a coda" / "extend" / "continue" / "keep going" → emit_appended_bars, EVEN IF the user describes the new content in detail.`,
  `- "add a bass line / inner voice / harmony / left-hand part" to a RANGE of existing bars → emit_replacement_bars over that range (the score already has its staves; write into the existing staff — do NOT append empty bars, do NOT add a staff).`,
  `- "change" / "fix" / "rewrite" + a SPECIFIC range → emit_replacement_bars or edit_score.`,
  `- "raise the third note", "add a fermata", "make beat 3 staccato" → edit_score.`,
  `- "start over" / "scrap" / "rewrite from scratch" → emit_replacement_bars over the full bar range (rewrite in place).`,
  `- When in doubt between appending and rewriting, prefer appending — a wasted append is cheap; a silent wholesale replacement of the user's work is the bug we avoid.`,
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
  `TRANSFORMS via emit_replacement_bars ("make this Dorian/minor/major/jazzier", "add a flat 7", "make it bluesy", "harmonize"): you MUST actually REALIZE the change in the emitted notes. The key signature stays fixed on this path, so apply the alteration with EXPLICIT ACCIDENTALS on every affected pitch (set accidental:'flat'/'sharp'/'natural'). E.g. C Ionian → Dorian = flat the 3rd and 7th: every E→E with accidental 'flat', every B→B with accidental 'flat'; natural minor also flats the 6th (A→A flat). Do NOT echo the original pitches unchanged — an emit_replacement_bars that returns the same notes has NOT performed the requested transform.`,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call emit_inserted_bars, follow this guidance exactly:`,
  INSERT_SYSTEM_PROMPT,
  ``,
  `─────────────────────────────────────────────────────────────────`,
  `When you call edit_score, follow the op vocabulary exactly:`,
  INTRA_SYSTEM_PROMPT,
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

/** The four structural edit-tools with their EXACT schemas; insert/region add
 *  the range fields so the model emits them inline (no separate dispatch).
 *  render_score (whole-score rewrite) is deliberately NOT exposed — it is
 *  Pro-only and would bypass the replacement-confirmation gate on the free path. */
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
  ]
}

type PerVoiceContent = z.infer<typeof EmitAppendedBarsSchema>['perVoiceContent']

/**
 * Clamp the bar-aligned `perVoiceContent` to `maxBars` bars so it stays in lock-
 * step with a clamped primary `measures` array (each inner voice carries one
 * Measure per appended/inserted bar). Returns undefined unchanged.
 */
function clampPerVoiceContent(
  pvc: PerVoiceContent,
  maxBars: number,
): PerVoiceContent {
  if (pvc === undefined) return undefined
  return pvc.map((staff) => ({
    voices: staff.voices.map((voice) => voice.slice(0, maxBars)),
  }))
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
  maxBars: number,
): {
  score: Score
  appliedOps: Operation[]
  warnings: string[]
  cadenceAtBoundary: boolean
  preservation: { ok: boolean; mismatchCount: number }
} {
  const warnings: string[] = []

  // Free-tier bar budget: clamp appended bars to maxBars, mirroring
  // runDispatchedHandler's extend clamp (index.ts). A model that ignores the
  // prompt budget still cannot exceed it. perVoiceContent is bar-aligned (each
  // voice is one Measure per appended bar), so clamp it to the same length.
  let emittedMeasures = parsed.measures
  let perVoiceContent = parsed.perVoiceContent
  if (emittedMeasures.length > maxBars) {
    const requested = emittedMeasures.length
    emittedMeasures = emittedMeasures.slice(0, maxBars)
    perVoiceContent = clampPerVoiceContent(perVoiceContent, maxBars)
    warnings.push(
      `Free tier adds up to ${maxBars} bars at a time — added ${maxBars} of the ${requested} emitted. Switch to Pro for longer sections.`,
    )
  }

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
    ...(perVoiceContent !== undefined ? { perVoiceContent } : {}),
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
  const model = input.modelOverride ?? selected.model ?? DEFAULT_HAIKU_MODEL
  const tools = buildTools(score)
  const maxBars = input.policy.maxBars

  // max_tokens matches the 2-call EDIT handlers (region/extend/insert all use
  // 8000), NOT the bounded-GENERATION ceiling (BOUNDED_EMIT_CEILING=2600). That
  // ceiling bounds fresh free-tier generation, not edits — clamping it here
  // truncated whole-region rewrites (e.g. "make this Dorian"). The free-tier
  // cost bound on edits is the BAR budget (maxBars), enforced by the apply
  // clamps + budgetNote below — not an output-token ceiling.
  const maxTokens = EDIT_MAX_TOKENS

  // Validation-retry loop (mirrors the handlers): ONE retry. If apply /
  // validateScore throws a ValidationError on attempt 1, re-issue the SAME
  // multiToolCall with the failure threaded into the user text and re-apply. On
  // the 2nd failure — or any non-ValidationError — throw. The text/answer path
  // can't fail validation, so it returns without consuming a retry.
  //
  // Tell the model the free-tier bar budget up front (the apply also CLAMPS, so a
  // model that ignores it still can't exceed the budget — this just avoids wasting
  // output authoring bars that would be dropped).
  const budgetNote = `BUDGET: when adding bars (emit_appended_bars / emit_inserted_bars), emit AT MOST ${maxBars} new bar${maxBars === 1 ? '' : 's'}.`
  const baseUserText = `${input.userText}\n\n${budgetNote}\n\n${buildScoreSummary(score)}`
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
      maxTokens,
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
          const applied = applyExtend(score, parsed.data, maxBars)
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
          // Free-tier bar budget: clamp inserted bars to maxBars, mirroring
          // runDispatchedHandler's insert clamp (index.ts). perVoiceContent is
          // bar-aligned so clamp it to the same length.
          const insertWarnings: string[] = []
          let insertedMeasures = parsed.data.measures
          let insertPvc = parsed.data.perVoiceContent
          if (insertedMeasures.length > maxBars) {
            const requested = insertedMeasures.length
            insertedMeasures = insertedMeasures.slice(0, maxBars)
            insertPvc = clampPerVoiceContent(insertPvc, maxBars)
            insertWarnings.push(
              `Free tier inserts up to ${maxBars} bars at a time — inserted ${maxBars} of the ${requested} emitted. Switch to Pro for more.`,
            )
          }
          const op: Operation = {
            kind: 'insertMeasuresAfter',
            afterMeasureIdx: parsed.data.afterMeasureIdx,
            measures: insertedMeasures,
            ...(insertPvc !== undefined ? { perVoiceContent: insertPvc } : {}),
          }
          const next = transformScore(score, op)
          validateScore(next)
          return {
            ...base,
            score: next,
            classification: classificationFor('compose'),
            appliedOps: [op],
            dispatchTool: 'insert_measures',
            ...(insertWarnings.length > 0 ? { warnings: insertWarnings } : {}),
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
