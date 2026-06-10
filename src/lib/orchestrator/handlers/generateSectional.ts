import type { Score } from '@/lib/music/types'
import type {
  Classification,
  OrchestratorResult,
  OrchestratorScoreStream,
  ScoreStreamEvent,
} from '../types'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import type { SystemBlock } from '@/lib/providers/types'
import { OutputTruncatedError } from '@/lib/providers/types'
import { MULTI_STAFF_REFERENCE } from '@/lib/llm/systemPrompt'
import { recordUsage } from '../budget'
import { ValidationError } from '@/lib/music/errors'
import { callWithScoreRetry } from './scoreRetry'
import { runExtendComposition, ExtendCompositionError } from './extendComposition'
import { runPlanScore, planToSegments, type ScorePlan } from './planScore'

/**
 * Sectional generation (M25) — generate a whole piece as a sequence of
 * BOUNDED sections so no single LLM call ever truncates.
 *
 * Pipeline: plan -> seed the opening section -> extend each remaining
 * section (reusing runExtendComposition, which preserves prior bars and
 * smooths the seam), assembled server-side.
 *
 * PR-4 makes it STREAMING: `sectionalEvents` is an async generator that
 * yields a `section` event after each section so the route can stream
 * the score growing in the editor, then a terminal `done` (or `error`).
 * `runGenerateSectionalStream` wraps it as an OrchestratorScoreStream;
 * `runGenerateSectional` drains it to a single OrchestratorResult for
 * non-streaming callers (and unit tests).
 *
 * Adaptive sizing: bars are generated GENERATION_CHUNK_BARS at a time.
 * If a chunk STILL truncates (a pathologically dense few bars), the
 * generator HALVES it and retries — down to a single bar — instead of
 * failing the whole piece. So density never produces the "section too
 * dense" dead-end; it just costs an extra (smaller) call.
 *
 * Resilience: a planner failure degrades to a single-section plan
 * (runPlanScore); a mid-piece chunk failure that can't be split keeps
 * the valid score assembled so far and finishes with a warning; only a
 * failed OPENING chunk (no score at all) is fatal.
 */

/** Per-call output ceiling. */
const SECTION_MAX_TOKENS = 8_000
/**
 * Bars per bounded LLM call. Small enough that a dense grand-staff chunk
 * fits SECTION_MAX_TOKENS (an 8-bar opening was overflowing it — the
 * "section too dense" failure). A musical section longer than this (the
 * planner may emit up to 32) generates as several contiguous chunks.
 */
const GENERATION_CHUNK_BARS = 4

/**
 * Section-progress logging to stdout. Mirrors the observability.ts
 * ORCHESTRATOR_LOG_SILENT convention so unit-test runs stay quiet but the
 * dev server / production logs show each chunk, every adaptive split, and
 * the terminal outcome (the diagnostic gap that made the first "too
 * dense" failure invisible in the logs).
 */
function logSection(message: string): void {
  if (process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
    console.warn(`[sectional] ${message}`)
  }
}

export class SectionalGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SectionalGenerationError'
  }
}

export interface RunGenerateSectionalInput {
  classification: Classification
  chatId: string
  /** Original user prompt — drives the planner and seeds every section. */
  userText: string
  modelOverride?: string
  apiKeyOverride?: string
}

/** One unit of bounded generation work. The queue is mutable: an adaptive
 *  split replaces an item with two smaller ones at the front. */
interface WorkItem {
  bars: number
  label: string
  hint?: string
}

const SEED_ROLE = `You compose the OPENING section of a larger piece that is extended bar-by-bar after you. Emit the render_score tool with the EXACT metadata you are given and ONLY the requested number of opening bars. Write a strong, idiomatic opening that later sections can grow from. Do NOT emit explanatory text — the tool call IS your response.

Pitch encoding: a pitch's "step" is ALWAYS a single bare letter C D E F G A B (or "rest"); accidentals go in the SEPARATE "accidental" field. NEVER merge them into step — a B-flat is {"step":"B","accidental":"flat"}, never "Bb"; an F-sharp is {"step":"F","accidental":"sharp"}, never "F#". This matters most in flat/sharp-heavy keys (e.g. Bbm, Db) where most notes carry an accidental.`

function seedConstraints(
  plan: ScorePlan,
  seg: { bars: number; sectionLabel: string; hint?: string },
): string {
  const meta = [
    `key = ${plan.key}`,
    `meter = ${plan.meter}`,
    ...(plan.tempo_bpm ? [`tempo_bpm = ${plan.tempo_bpm}`] : []),
    ...(plan.title ? [`title = ${JSON.stringify(plan.title)}`] : []),
  ].join('; ')
  const staffLine = plan.grandStaff
    ? `Include a secondStaff (clef "bass") with the SAME ${seg.bars} measures — this is two-hand piano / grand staff.`
    : `Single staff, clef "${plan.clef ?? 'treble'}".`
  return [
    `THIS CALL — emit EXACTLY:`,
    `- metadata: ${meta}`,
    `- ${seg.bars} measure${seg.bars === 1 ? '' : 's'} on the primary staff; each measure's durations MUST sum to the meter.`,
    `- ${staffLine}`,
    `- this is the "${seg.sectionLabel}" section${seg.hint ? `: ${seg.hint}` : ''}.`,
    `Do NOT emit more than ${seg.bars} bars — later sections are appended separately.`,
  ].join('\n')
}

function seedSystemBlocks(): SystemBlock[] {
  return [{ text: SEED_ROLE }, { text: MULTI_STAFF_REFERENCE, cache: true }]
}

interface UsageTotals {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

/** Build a WorkItem, omitting `hint` when absent (exactOptionalPropertyTypes). */
function workItem(bars: number, label: string, hint?: string): WorkItem {
  return { bars, label, ...(hint !== undefined ? { hint } : {}) }
}

/**
 * The core generator: plan -> work through a queue of bounded chunks
 * (the first chunk seeds the Score; the rest extend it), yielding a
 * `section` event after each, then a terminal `done` (clean or partial)
 * or `error` (fatal — the opening chunk could not be produced).
 */
export async function* sectionalEvents(
  input: RunGenerateSectionalInput,
): AsyncGenerator<ScoreStreamEvent> {
  const warnings: string[] = []
  let inTok = 0
  let outTok = 0
  let cachedTok = 0
  const addUsage = (u?: UsageTotals) => {
    if (!u) return
    inTok += u.inputTokens ?? 0
    outTok += u.outputTokens ?? 0
    cachedTok += u.cachedInputTokens ?? 0
  }

  // 1. Plan (cheap, bounded; degrades to a single section).
  const planResult = await runPlanScore({
    userText: input.userText,
    chatId: input.chatId,
    ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
    ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
  })
  addUsage(planResult.usage)
  const plan = planResult.plan
  if (planResult.model === 'fallback') {
    warnings.push('Planner fell back to a single-section plan.')
  }
  // Chunk musical sections into bounded generation units (<= GENERATION_CHUNK_BARS).
  const segments = planToSegments(plan, GENERATION_CHUNK_BARS)
  if (segments.length === 0) {
    yield { type: 'error', error: new SectionalGenerationError('plan produced no segments') }
    return
  }
  const queue: WorkItem[] = segments.map((s) => workItem(s.bars, s.sectionLabel, s.hint))
  logSection(
    `plan: ${plan.grandStaff ? 'grand-staff ' : ''}${plan.key} ${plan.meter}, ${queue.reduce((n, w) => n + w.bars, 0)} bars in ${queue.length} chunk(s)`,
  )

  // SHE-19: the seam now drives the tier (Haiku for simple, Sonnet for complex sections).
  // Bounded sections don't need Opus; this matches the extend path so the whole
  // piece is one consistent voice.
  const selected = selectProvider(resolveModelClass({ callType: 'section', complexity: input.classification.complexity }), input.chatId)
  const seedModel = input.modelOverride ?? selected.model

  let score: Score | undefined
  let lastToolUseId: string | undefined
  let lastModel = seedModel
  let sectionsBuilt = 0

  // 2. Work the queue. First chunk (no score yet) seeds; the rest extend.
  while (queue.length > 0) {
    const item = queue.shift() as WorkItem
    const isSeed = score === undefined
    logSection(
      `${isSeed ? 'seed' : 'extend'} "${item.label}" (${item.bars} bar${item.bars === 1 ? '' : 's'}); ${queue.length} chunk(s) queued`,
    )
    try {
      if (isSeed) {
        const seedResult = await callWithScoreRetry(
          { ...selected, chatId: input.chatId },
          {
            systemPrompt: seedSystemBlocks(),
            userText: `USER REQUEST: ${input.userText}\n\n${seedConstraints(plan, {
              bars: item.bars,
              sectionLabel: item.label,
              ...(item.hint !== undefined ? { hint: item.hint } : {}),
            })}`,
            maxTokens: SECTION_MAX_TOKENS,
            // One feedback retry, then let the adaptive split shrink the
            // chunk — cheaper than burning many slow attempts at a size the
            // model can't satisfy.
            maxRetries: 1,
            modelOverride: seedModel,
            ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
            providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
          },
        )
        addUsage(seedResult.usage)
        score = seedResult.input
        lastToolUseId = seedResult.toolUseId
        lastModel = seedResult.model
      } else {
        const ext = await runExtendComposition({
          classification: input.classification,
          editedScore: score as Score,
          userText: `Continue the piece: the "${item.label}" section${item.hint ? ` — ${item.hint}` : ''}.`,
          targetBars: item.bars,
          maxTokens: SECTION_MAX_TOKENS,
          ...(item.hint !== undefined ? { hint: item.hint } : {}),
          chatId: input.chatId,
          ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
          ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
        })
        score = ext.score
        if (ext.toolUseId) lastToolUseId = ext.toolUseId
        if (ext.model) lastModel = ext.model
        if (ext.warnings) warnings.push(...ext.warnings)
        addUsage(ext.usage)
      }
      sectionsBuilt++
      yield {
        type: 'section',
        score: score as Score,
        sectionIndex: sectionsBuilt - 1,
        totalSections: sectionsBuilt + queue.length,
        label: item.label,
      }
    } catch (e) {
      // A chunk that truncated (too dense for the token budget) OR that
      // the model couldn't make rhythmically valid at this size — halve it
      // and retry the smaller pieces (down to a single bar) rather than
      // failing. A 1-bar measure is far easier to get right than a dense
      // 4-bar passage, so shrinking turns both the "too dense" and the
      // "duration sum" dead-ends into a (slightly slower) success.
      const splittable =
        e instanceof OutputTruncatedError ||
        e instanceof ValidationError ||
        e instanceof ExtendCompositionError
      if (splittable && item.bars > 1) {
        const first = Math.ceil(item.bars / 2)
        const rest = item.bars - first
        const why = e instanceof OutputTruncatedError ? 'truncated' : 'failed validation'
        logSection(
          `"${item.label}" ${why} at ${item.bars} bars — splitting -> ${first}${rest > 0 ? ` + ${rest}` : ''} and retrying`,
        )
        // Re-queue at the FRONT, smaller half first.
        if (rest > 0) queue.unshift(workItem(rest, item.label, item.hint))
        queue.unshift(workItem(first, item.label, item.hint))
        continue
      }

      const msg = e instanceof Error ? e.message : String(e)
      if (score === undefined) {
        // The opening chunk failed and we have no usable score — fatal.
        logSection(`fatal: opening chunk "${item.label}" (${item.bars} bar) failed: ${msg}`)
        yield { type: 'error', error: e instanceof Error ? e : new Error(msg) }
        return
      }
      // Mid-piece failure: keep the valid score so far, finish with a notice.
      logSection(`stopped after ${sectionsBuilt} chunk(s); "${item.label}" failed: ${msg}`)
      warnings.push(
        `Stopped after ${sectionsBuilt} section${sectionsBuilt === 1 ? '' : 's'} — generating "${item.label}" failed: ${msg}`,
      )
      break
    }
  }

  if (score === undefined) {
    yield { type: 'error', error: new SectionalGenerationError('sectional generation produced no score') }
    return
  }

  recordUsage(input.chatId, inTok || undefined, outTok || undefined)
  const totalBars = score.measures.length
  const introText = `Composed a ${totalBars}-bar ${plan.grandStaff ? 'grand-staff ' : ''}piece in ${sectionsBuilt} section${sectionsBuilt === 1 ? '' : 's'}${plan.title ? ` — "${plan.title}"` : ''}.`
  logSection(`done: ${totalBars} bars in ${sectionsBuilt} chunk(s)${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)
  yield {
    type: 'done',
    score,
    ...(lastToolUseId !== undefined ? { toolUseId: lastToolUseId } : {}),
    introText,
    model: lastModel,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(inTok || outTok
      ? { usage: { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: cachedTok } }
      : {}),
  }
}

/**
 * Streaming entry point — wraps the generator as an OrchestratorScoreStream
 * the route consumes over SSE. The generator runs lazily as the route
 * iterates it (so each bounded section call happens during streaming,
 * within the route's maxDuration, not all up front).
 */
export function runGenerateSectionalStream(
  input: RunGenerateSectionalInput,
): OrchestratorScoreStream {
  const t0 = Date.now()
  // Best-effort header model (the real per-section model rides on `done`).
  // SHE-19: seam-driven tier (Haiku for simple, Sonnet for complex sections).
  const headerModel = input.modelOverride ?? selectProvider(resolveModelClass({ callType: 'section', complexity: input.classification.complexity }), input.chatId).model
  return {
    outcomeKind: 'score_stream',
    classification: input.classification,
    model: headerModel,
    events: sectionalEvents(input),
    chatId: input.chatId,
    latencyMs: Date.now() - t0,
  }
}

/**
 * Non-streaming entry point — drains the generator to a single result.
 * Throws on a fatal (`error`) event; returns the partial-but-valid score
 * (with warnings) when a later section stopped early.
 */
export async function runGenerateSectional(
  input: RunGenerateSectionalInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  let score: Score | undefined
  let toolUseId: string | undefined
  let introText: string | undefined
  let model: string | undefined
  let warnings: string[] | undefined
  let usage: UsageTotals | undefined
  for await (const ev of sectionalEvents(input)) {
    if (ev.type === 'section') {
      score = ev.score
    } else if (ev.type === 'done') {
      score = ev.score
      toolUseId = ev.toolUseId
      introText = ev.introText
      model = ev.model
      warnings = ev.warnings
      usage = ev.usage
    } else {
      // Fatal: no usable score. Re-throw so the route maps it cleanly.
      throw ev.error
    }
  }
  if (!score) throw new SectionalGenerationError('sectional generation produced no score')
  return {
    score,
    classification: input.classification,
    model: model ?? 'unknown',
    latencyMs: Date.now() - t0,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    introText: introText ?? 'Composed your piece.',
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
    ...(usage ? { usage } : {}),
  }
}
