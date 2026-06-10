import { z } from 'zod'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError } from '@/lib/providers/types'

/**
 * Score planner (M25-PR-1) — the first stage of unlimited streamed score
 * generation.
 *
 * A whole-score render cannot fit in one bounded, time-limited LLM call
 * (see the M25 root-cause: a 16-bar grand-staff render needs ~15-25k
 * output tokens and blows both the token ceiling and the 60s request
 * wall). The fix is to generate in bounded SECTIONS and assemble them.
 *
 * This module owns the FIRST step of that pipeline: turn a prose request
 * for a NEW piece into a structural PLAN — key, meter, tempo, grand-staff
 * y/n, and an ordered list of musical sections (label + bars + hint). It
 * writes NO notes; the seed + sectional-extend loop (PR-2) consume the
 * plan and call the bounded render path per segment.
 *
 * Separation of concerns:
 *  - a SECTION is a musical unit ("Intro", "A", "Turnaround") of any
 *    reasonable length the planner chooses.
 *  - a SEGMENT is a generation chunk (<= MAX_SECTION_BARS bars) that one
 *    bounded LLM call can emit without truncating. `planToSegments`
 *    splits sections into segments; the loop in PR-2 iterates segments.
 *
 * Resilience: `runPlanScore` never throws on a bad/empty model response —
 * it falls back to `fallbackPlan` (a single deterministic section) so the
 * caller always has a usable plan. The plan's key/meter are validated
 * loosely here (the downstream render_score schema enforces the closed
 * enums), so a slightly-off planner suggestion can't dead-end generation.
 */

const PLAN_TOOL_NAME = 'emit_score_plan'

/** Per-segment bar ceiling — small enough that one bounded generation
 *  call comfortably fits under the per-section token budget PR-2 sets.
 *  Grand-staff doubles per-bar tokens, so this stays conservative. */
export const MAX_SECTION_BARS = 8
/** Upper bound on a single section the planner may propose (longer ones
 *  are split into segments by `planToSegments`). */
export const MAX_PLAN_SECTION_BARS = 32
/** Total-length guardrail so a runaway plan can't request an unbounded
 *  number of LLM calls. Live-streaming caps practical length below this. */
export const MAX_TOTAL_BARS = 512
export const MAX_SECTIONS = 64

const PLAN_MAX_TOKENS = 900

export interface ScorePlanSection {
  /** Short musical label: "Intro", "A", "B", "Bridge", "Turnaround", "Coda". */
  label: string
  /** Bars in this section (1..MAX_PLAN_SECTION_BARS). */
  bars: number
  /** One-line compositional intent passed to the section generator. */
  hint?: string
}

export interface ScorePlan {
  title?: string
  /** e.g. "C", "Bb", "F#m". Loosely typed here; render_score enforces the
   *  closed key set downstream. */
  key: string
  /** e.g. "4/4", "6/8", "C". render_score enforces the meter pattern. */
  meter: string
  tempo_bpm?: number
  clef?: 'treble' | 'bass'
  /** When true, generate a two-staff (grand-staff / piano) layout. */
  grandStaff: boolean
  sections: ScorePlanSection[]
}

/** One bounded generation chunk derived from the plan. */
export interface ScorePlanSegment {
  /** 0-based segment index across the whole plan. */
  index: number
  /** Bars to generate in this segment (<= MAX_SECTION_BARS). */
  bars: number
  /** Owning section label (for prompts + progress display). */
  sectionLabel: string
  /** Owning section hint, if any. */
  hint?: string
  /** True for the segment that opens the piece (PR-2 seeds metadata here,
   *  later segments extend). */
  isFirst: boolean
}

export const ScorePlanSectionSchema = z.object({
  label: z.string().min(1).max(40),
  bars: z.number().int().min(1).max(MAX_PLAN_SECTION_BARS),
  hint: z.string().max(280).optional(),
})

export const ScorePlanSchema = z.object({
  title: z.string().max(120).optional(),
  key: z.string().min(1).max(4),
  meter: z.string().min(1).max(8),
  tempo_bpm: z.number().int().min(20).max(320).optional(),
  clef: z.enum(['treble', 'bass']).optional(),
  grandStaff: z.boolean(),
  sections: z.array(ScorePlanSectionSchema).min(1).max(MAX_SECTIONS),
})

const PLAN_TOOL_INPUT_SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'meter', 'grandStaff', 'sections'],
  properties: {
    title: { type: 'string', maxLength: 120, description: 'Short title for the piece. Omit if the user gave none — do not fabricate a credit.' },
    key: {
      type: 'string',
      description: 'Key signature, e.g. "C", "G", "F#", "Bb", "Am", "Dm". Major = bare letter; minor = letter + "m".',
    },
    meter: {
      type: 'string',
      description: 'Time signature: "4/4", "3/4", "6/8", "C" (common), "C|" (cut). Honor any meter the user names.',
    },
    tempo_bpm: { type: 'integer', minimum: 20, maximum: 320, description: 'Tempo in BPM. Pick a value that fits the style (e.g. a driving funk ~108-120).' },
    clef: { type: 'string', enum: ['treble', 'bass'], description: 'Primary staff clef. Defaults to treble. Use bass for low-register single-staff pieces.' },
    grandStaff: {
      type: 'boolean',
      description: 'true for two-staff piano / grand-staff writing (right hand treble + left hand bass). Set true when the user asks for piano, grand staff, or two hands.',
    },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SECTIONS,
      description: 'Ordered musical sections that sum to the requested length. Each is a coherent unit (Intro, A, B, Bridge, Turnaround, Coda). Choose bar counts that add up to the total the user asked for.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'bars'],
        properties: {
          label: { type: 'string', maxLength: 40, description: 'Short label: "Intro", "A", "B", "Bridge", "Turnaround", "Coda".' },
          bars: { type: 'integer', minimum: 1, maximum: MAX_PLAN_SECTION_BARS, description: `Bars in this section (1..${MAX_PLAN_SECTION_BARS}).` },
          hint: { type: 'string', maxLength: 280, description: 'One-line compositional intent for this section, e.g. "syncopated dominant-7 groove", "i-iv-V turnaround landing on V".' },
        },
      },
    },
  },
}

const PLAN_SYSTEM_PROMPT = `You are the PLANNER for sheet-llm. The user wants a NEW piece of music generated. Your job is to produce a STRUCTURAL PLAN — not notes.

Call the emit_score_plan tool exactly once. Do NOT write any pitches, durations, or measures; a later stage composes each section.

DECIDE:
- key, meter, tempo, and whether the piece is grand-staff (two-hand piano). Honor anything the user states explicitly (key, meter, instrumentation, length); infer sensible defaults otherwise.
- an ordered list of SECTIONS that sum to the requested total length. Each section is a coherent musical unit with a short label (Intro, A, B, Bridge, Turnaround, Coda) and a bar count. Give each section a one-line hint describing its compositional intent.

RULES:
- The section bar counts MUST add up to the total number of bars the user asked for (e.g. "16 bars" -> sections summing to 16). If the user gives no length, plan a compact, complete piece (8-16 bars).
- Keep each section <= ${MAX_PLAN_SECTION_BARS} bars where natural; longer musical sections are fine (up to ${MAX_PLAN_SECTION_BARS * 4}) and will be chunked downstream.
- If the user mentions a "turnaround", "coda", "tag", or "ending", make it its own final section.
- Pick a key/meter/tempo idiomatic to the requested style.
- Do NOT emit explanatory text — the tool call IS your response.

EXAMPLE
User: "a driving blues-funk rhythm in grand staff. 16 bars with a turnaround at the end."
emit_score_plan({
  title: "Blues-Funk Groove",
  key: "C",
  meter: "4/4",
  tempo_bpm: 112,
  clef: "treble",
  grandStaff: true,
  sections: [
    { label: "A", bars: 8, hint: "driving funk: syncopated RH stabs over a walking/​octave LH bass on C7" },
    { label: "B", bars: 6, hint: "move to the IV (F7) then back, keep the 16th-note funk groove" },
    { label: "Turnaround", bars: 2, hint: "ii-V-I turnaround (Dm7-G7-C7) landing to set up a repeat" }
  ]
})`

export interface RunPlanScoreInput {
  userText: string
  chatId?: string
  modelOverride?: string
  apiKeyOverride?: string
}

export interface PlanScoreResult {
  plan: ScorePlan
  /** The model that authored the plan, or 'fallback' when the deterministic
   *  plan was used (LLM call failed or returned an unusable shape). */
  model: string
  toolUseId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
  }
}

/**
 * Deterministic fallback plan — used when the planner LLM call fails or
 * returns an unusable shape, so the generation pipeline always has a
 * plan to proceed with. Single section of `targetBars` (default 8) split
 * downstream into <= MAX_SECTION_BARS segments.
 */
export function fallbackPlan(opts?: {
  targetBars?: number
  grandStaff?: boolean
  key?: string
  meter?: string
  title?: string
}): ScorePlan {
  const bars = clampBars(opts?.targetBars ?? 8)
  return {
    ...(opts?.title !== undefined ? { title: opts.title } : {}),
    key: opts?.key ?? 'C',
    meter: opts?.meter ?? '4/4',
    grandStaff: opts?.grandStaff ?? false,
    sections: [{ label: 'A', bars, hint: 'compose the full piece in the requested style' }],
  }
}

function clampBars(n: number): number {
  if (!Number.isFinite(n)) return 8
  return Math.max(1, Math.min(MAX_PLAN_SECTION_BARS, Math.round(n)))
}

/**
 * Flatten a plan's musical sections into bounded generation SEGMENTS,
 * each <= maxBars. Pure. The PR-2 loop iterates these: segment 0 seeds
 * the score; later segments extend it.
 *
 * Over-long sections are split into ceil(bars/maxBars) segments that
 * carry the same label + hint. The total segment-bar sum equals the
 * plan's total bars (capped at MAX_TOTAL_BARS as a runaway guard).
 */
export function planToSegments(
  plan: ScorePlan,
  maxBars: number = MAX_SECTION_BARS,
): ScorePlanSegment[] {
  const cap = Math.max(1, Math.floor(maxBars))
  const segments: ScorePlanSegment[] = []
  let total = 0
  for (const section of plan.sections) {
    let remaining = section.bars
    while (remaining > 0) {
      if (total >= MAX_TOTAL_BARS) return segments
      const bars = Math.min(cap, remaining, MAX_TOTAL_BARS - total)
      if (bars <= 0) return segments
      segments.push({
        index: segments.length,
        bars,
        sectionLabel: section.label,
        ...(section.hint !== undefined ? { hint: section.hint } : {}),
        isFirst: segments.length === 0,
      })
      remaining -= bars
      total += bars
    }
  }
  return segments
}

/** Total bars across a plan's sections. */
export function totalPlannedBars(plan: ScorePlan): number {
  return plan.sections.reduce((sum, s) => sum + s.bars, 0)
}

/**
 * Run the planner LLM call. Resilient: on any provider/parse failure it
 * returns a deterministic `fallbackPlan` (model='fallback') rather than
 * throwing, so the generation pipeline never dead-ends at the planning
 * stage. Tier: seam-driven (SHE-19: defaults to Haiku; plan has no complexity → small).
 */
export async function runPlanScore(input: RunPlanScoreInput): Promise<PlanScoreResult> {
  const selected = selectProvider(resolveModelClass({ callType: 'plan' }), input.chatId)
  try {
    const result = await callWithFailover<z.infer<typeof ScorePlanSchema>>(
      { ...selected, chatId: input.chatId },
      {
        name: PLAN_TOOL_NAME,
        description:
          'Emit a structural plan for a new piece: key, meter, tempo, grand-staff flag, and an ordered list of sections (label + bars + hint). Do NOT write notes.',
        inputSchema: ScorePlanSchema,
        inputSchemaJson: PLAN_TOOL_INPUT_SCHEMA_JSON,
      },
      {
        systemPrompt: PLAN_SYSTEM_PROMPT,
        userText: input.userText,
        toolChoice: 'required',
        maxTokens: PLAN_MAX_TOKENS,
        temperature: 0,
        // The plan is a short structural outline (key/meter/sections), not
        // the notes — low effort is plenty and keeps the planner cheap.
        effort: 'low',
        thinking: 'disabled',
        modelOverride: input.modelOverride ?? selected.model,
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
        providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
      },
    )
    return {
      plan: result.input,
      model: result.model,
      toolUseId: result.toolUseId,
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
  } catch (e) {
    // Planner is best-effort. A malformed plan (ProviderSchemaError) or a
    // transient upstream error must not block generation — fall back to a
    // single-section deterministic plan and let the section loop proceed.
    if (e instanceof ProviderSchemaError) {
      return { plan: fallbackPlan(), model: 'fallback' }
    }
    // UpstreamError / RateLimitedError: also degrade to fallback rather
    // than failing the whole generation at the planning stage.
    return { plan: fallbackPlan(), model: 'fallback' }
  }
}
