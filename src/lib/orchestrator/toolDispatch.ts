import { z } from 'zod'
import type { Score, Event } from '@/lib/music/types'
import type { ChatMessage } from '@/lib/llm/wrapper'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError } from '@/lib/providers/types'

/**
 * Native tool-use dispatch (M3.5-PR-3) — replaces the Haiku intent
 * classifier with a Claude tool-pick. Claude itself decides among five
 * tools given the full prompt + a compact score summary; tool_choice
 * is "auto" so the model picks freely.
 *
 * The five tools:
 *  - extend_composition({ targetBars, hint? })
 *  - insert_measures({ afterMeasureIdx, count, hint? })
 *  - region_replace({ startMeasureIdx, endMeasureIdx, hint })
 *  - edit_intra_measure({ targetDescription })
 *  - regenerate_all({ confirmExplicitRewrite: true, justification })
 *      — schema enforces confirmExplicitRewrite must be true; the model
 *        only sets it when the user explicitly asked to replace.
 *
 * The result is a DispatchDecision { tool, args, confidence }. The
 * confidence is heuristic — Claude doesn't return a native confidence
 * score for tool picks. We set 0.85 for explicit tool calls and 0.0
 * for refusals/timeouts; document this limitation upfront.
 */

export type DispatchToolName =
  | 'extend_composition'
  | 'insert_measures'
  | 'region_replace'
  | 'edit_intra_measure'
  | 'regenerate_all'
  | 'answer_question'

export const DispatchToolNames: ReadonlyArray<DispatchToolName> = [
  'extend_composition',
  'insert_measures',
  'region_replace',
  'edit_intra_measure',
  'regenerate_all',
  'answer_question',
]

export interface ExtendCompositionArgs {
  targetBars: number
  hint?: string
}

export interface InsertMeasuresArgs {
  afterMeasureIdx: number
  count: number
  hint?: string
}

export interface RegionReplaceArgs {
  startMeasureIdx: number
  endMeasureIdx: number
  hint: string
}

export interface EditIntraMeasureArgs {
  targetDescription: string
}

export interface RegenerateAllArgs {
  confirmExplicitRewrite: true
  justification: string
}

export interface AnswerQuestionArgs {
  question: string
}

export type DispatchArgs =
  | { tool: 'extend_composition'; args: ExtendCompositionArgs }
  | { tool: 'insert_measures'; args: InsertMeasuresArgs }
  | { tool: 'region_replace'; args: RegionReplaceArgs }
  | { tool: 'edit_intra_measure'; args: EditIntraMeasureArgs }
  | { tool: 'regenerate_all'; args: RegenerateAllArgs }
  | { tool: 'answer_question'; args: AnswerQuestionArgs }

export interface DispatchDecision {
  tool: DispatchToolName
  args:
    | ExtendCompositionArgs
    | InsertMeasuresArgs
    | RegionReplaceArgs
    | EditIntraMeasureArgs
    | RegenerateAllArgs
    | AnswerQuestionArgs
  /**
   * Heuristic 0..1. Anthropic's tool-use API doesn't return native
   * confidence; we set 0.85 for explicit picks and 0.0 for refusals.
   * Future work: derive from log-probabilities when the API supports
   * them. Documented limitation.
   */
  confidence: number
  /** The model that authored the decision. */
  model: string
  /** Tool-use id for downstream persistence. */
  toolUseId: string
  /** Token usage for budget tracking. */
  usage?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  }
}

export class ToolDispatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolDispatchError'
  }
}

// String caps are deliberately GENEROUS (2000) so a thorough hint/description
// is never hard-rejected for being detailed — the dispatch call's
// maxTokens:300 is the real bound on how long these can get (~1k chars). The
// schema sent to the model (inputSchemaJson) carries a smaller, soft guidance
// limit; these zod caps are just the backstop that must never trip in practice.
const STRING_CAP = 2000

const EXTEND_SCHEMA = z.object({
  targetBars: z.number().int().min(1).max(64),
  hint: z.string().max(STRING_CAP).optional(),
})

const INSERT_SCHEMA = z.object({
  afterMeasureIdx: z.number().int().min(-1),
  count: z.number().int().min(1).max(64),
  hint: z.string().max(STRING_CAP).optional(),
})

const REGION_SCHEMA = z.object({
  startMeasureIdx: z.number().int().min(0),
  endMeasureIdx: z.number().int().min(0),
  hint: z.string().min(1).max(STRING_CAP),
})

const EDIT_INTRA_SCHEMA = z.object({
  targetDescription: z.string().min(1).max(STRING_CAP),
})

const REGEN_SCHEMA = z.object({
  // Schema-enforced: must be `true`. The model only sets it when the
  // user explicitly asked to start over / rewrite — we don't trust
  // the model's word but we do trust its choice not to set it.
  confirmExplicitRewrite: z.literal(true),
  justification: z.string().min(1).max(STRING_CAP),
})

const ANSWER_QUESTION_SCHEMA = z.object({
  question: z.string().min(1).max(STRING_CAP),
})

const TOOL_DISPATCH_SYSTEM_PROMPT = `You are the DISPATCHER for sheet-llm. The user has an existing musical score and made a request. Pick exactly ONE of the six tools below by calling it with the appropriate arguments. Do NOT emit explanatory text — the tool call IS your response.

THE SIX TOOLS (pick the most specific applicable):

1. extend_composition({ targetBars, hint? })
   Use when the user wants to ADD measures to the END of the existing score.
   Trigger phrases: "add N more bars", "extend", "continue", "keep going",
   "another N measures", "add a coda", "tag", "more of the same".
   Args:
     - targetBars: how many new bars (1..64). Infer from the request
       ("add 4 more bars" → 4; "extend by another phrase" → 4 or 8).
     - hint (optional): a one-line note for the composition handler, e.g.
       "i-iv-V turnaround", "stepwise descent", "syncopated".
   Do NOT use this when the user asks to REPLACE the whole thing.

2. insert_measures({ afterMeasureIdx, count, hint? })
   Use when the user wants to insert N bars into the MIDDLE of the score.
   Trigger phrases: "insert N bars after measure 3", "add a bar between
   2 and 3", "splice in a bridge after the verse".
   Args:
     - afterMeasureIdx: 0-based; -1 = before bar 1.
     - count: how many new bars (1..64).
     - hint (optional).

3. region_replace({ startMeasureIdx, endMeasureIdx, hint })
   Use when the user wants to REWRITE a specific contiguous run of bars.
   Trigger phrases: "rewrite measures 5-8", "change bars 9 to 12 to a
   minor key", "fix the bridge", "replace the chorus".
   Args:
     - startMeasureIdx / endMeasureIdx: inclusive 0-based range.
     - hint: REQUIRED — a one-line description of what to put there.

4. edit_intra_measure({ targetDescription })
   Use when the user wants a SURGICAL edit — change/add/remove specific
   notes, articulations, dynamics, ornaments — NOT structural changes.
   Trigger phrases: "raise the third note", "add a fermata to the last
   note", "make beat 3 staccato", "change C to D in measure 5".
   Args:
     - targetDescription: a one-sentence description of the surgical edit
       (passed verbatim to the intra-measure handler).

5. regenerate_all({ confirmExplicitRewrite: true, justification })
   Use ONLY when the user EXPLICITLY asked to throw away the existing
   score and start over. Trigger phrases: "start over", "scrap this and
   write X", "rewrite from scratch", "I don't like this — make Y instead".
   Args:
     - confirmExplicitRewrite: MUST be true. You may only set this when
       the user's words make their intent explicit. If they're ambiguous,
       prefer one of the four structural tools instead.
     - justification: 1-2 sentences explaining WHY you believe the user
       wants a full rewrite (cite the trigger phrase).

6. answer_question({ question })
   Use when the user is ASKING A QUESTION about the existing score and
   wants an EXPLANATION — music theory, harmonic/melodic analysis, chord
   or key identification, or a "why does this work" / "what's happening
   here" walkthrough. This is the ONLY read-only tool: it changes NOTHING
   about the score, it just answers in prose.
   Trigger phrases: "explain ...", "what is / what's ...", "why does ...",
   "how does ...", "what's happening in ...", "what key/scale/mode is
   this", "name the chord ...", "analyze ...", "describe the bass line",
   "is this a ... cadence".
   Args:
     - question: the user's question restated in one sentence (the full
       original prompt is also forwarded to the handler).

DECISION RULES:
- "add N bars" / "add a coda" / "add a tag" / "extend" / "continue" / "keep going" / "more of the same" → extend_composition (append NEW bars at the END). NOT regenerate_all, EVEN IF the user describes the desired new content in detail. They want addition, not replacement.
- "add a bass line / melody / inner voice / counter-melody / harmony / accompaniment / a left-hand part / dynamics" to a RANGE of EXISTING bars (e.g. "add bass to bars 5-8", "put a counter-melody in the left hand for the bridge", "fill in the harmony in measures 9-12") → region_replace over that range. The user is ENRICHING existing bars, NOT appending new ones. The score ALREADY HAS its staves (a grand staff is a treble + a bass staff): write the new line INTO the existing staff via region_replace — NEVER add a staff, and do NOT extend_composition (that appends empty bars at the end).
- "change" / "fix" / "rewrite" + a SPECIFIC range or measure → region_replace or edit_intra_measure.
- "start over" / "scrap" / "throw away" → regenerate_all (only here).
- A QUESTION that wants an explanation, not an action ("explain ...", "what / why / how ...", "what's happening", "name the chord", "analyze the bass line") → answer_question. It modifies nothing.
- BUT a request phrased as a hypothetical edit is NOT a question: "what if you made it minor?", "could you make this jazzier?", "can you add a coda?" want a CHANGE — route them to the matching edit/structural tool, never answer_question.
- When in doubt between extend_composition and regenerate_all, pick extend_composition. A wasted append is cheap to undo; a silent replacement of the user's work is the bug we're fixing.

EXAMPLES:
User: "add 4 more bars with a i iv v turnaround" → extend_composition({ targetBars: 4, hint: "i-iv-V turnaround" })
User: "extend by another 8 bars" → extend_composition({ targetBars: 8 })
User: "insert 2 bars after measure 3" → insert_measures({ afterMeasureIdx: 3, count: 2 })
User: "rewrite measures 5-8 in D minor" → region_replace({ startMeasureIdx: 4, endMeasureIdx: 7, hint: "D minor; preserve the rhythmic profile" })   (bars are 0-indexed: bar 5 = index 4, bar 8 = index 7)
User: "add a bass line to bars 5-8" / "add bass to the existing grand staff for measures 5-8" → region_replace({ startMeasureIdx: 4, endMeasureIdx: 7, hint: "add a left-hand bass line in the existing bass-clef staff; keep the right hand (treble) unchanged" })   (the bass staff already exists — fill it; do NOT add a staff or extend)
User: "raise the third note an octave" → edit_intra_measure({ targetDescription: "raise the third note (event 2 of measure 0) by one octave" })
User: "scrap this and write me a Bach chorale in F" → regenerate_all({ confirmExplicitRewrite: true, justification: "User said 'scrap this and write me' — explicit replacement request." })
User: "make this jazzier" → edit_intra_measure({ targetDescription: "increase syncopation and add seventh chords throughout" }) (ambiguous; prefer surgical over wholesale)
User: "explain the bass line to me in terms of music theory — what's happening?" → answer_question({ question: "explain what the bass line is doing harmonically and melodically" })
User: "what key is this in and why does the ending sound resolved?" → answer_question({ question: "identify the key and explain why the ending sounds resolved" })
User: "name the chord on beat 2 of measure 3" → answer_question({ question: "name the chord on beat 2 of measure 3" })
User: "what if this were in a minor key?" → region_replace({ startMeasureIdx: 0, endMeasureIdx: <last>, hint: "transpose to the parallel minor" }) (hypothetical EDIT, not a question)
`

/**
 * Build a compact score summary (≤ ~2KB) for the dispatcher. Includes
 * measure count, key, meter, title, staff count, and the FIRST PITCH
 * of each event in the last 4 measures (so the model can reason about
 * boundary continuation).
 */
function buildScoreSummary(score: Score): string {
  const measureCount = score.measures.length
  const staffCount = score.secondStaff ? 2 : 1
  const tail = score.measures.slice(Math.max(0, measureCount - 4))
  const tailSummary = tail
    .map((m, i) => {
      const start = measureCount - tail.length + i
      const notes = m.events
        .map((e: Event) => {
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
  ].join('\n')
}

export interface ToolDispatchInput {
  userText: string
  editedScore?: Score
  history?: ReadonlyArray<ChatMessage>
  chatId?: string
  modelOverride?: string
  apiKeyOverride?: string
  /**
   * D5 — deterministic 0-based inclusive measure-range the user is acting
   * on (from a right-click AI entry). Injected as a structured region line
   * in the dispatch prompt so the model uses these EXACT indices for a
   * scoped request instead of parsing them from prose.
   */
  targetRegion?: import('@/lib/shared/types').TargetRegion
}

/**
 * The structured region-context line for the dispatch prompt (D5). 1-based
 * for the human-readable range; 0-based for the indices the tools consume.
 */
function buildRegionHint(region: import('@/lib/shared/types').TargetRegion): string {
  const { startMeasureIdx: s, endMeasureIdx: e } = region
  const human = s === e ? `measure ${s + 1}` : `measures ${s + 1}–${e + 1}`
  const idx = s === e ? `${s}` : `${s}..${e}`
  return [
    `SELECTED REGION: ${human} (0-based index ${idx}, inclusive). The user invoked this from a right-click ON that region.`,
    `When the request is scoped to "this"/"here"/"the selection"/"this measure"/"these bars", use these EXACT indices — region_replace startMeasureIdx=${s}, endMeasureIdx=${e}; edit_intra_measure should locate its target inside this range.`,
  ].join('\n')
}

interface RawDispatchOutput {
  tool: DispatchToolName
  input: unknown
  toolUseId: string
  model: string
  usage?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  }
}

/**
 * Issue the dispatch call with tool_choice='auto' so Claude picks
 * among the five tools freely. Returns a raw shape that `run()` then
 * validates against the per-tool zod schemas.
 */
async function callDispatch(input: ToolDispatchInput): Promise<RawDispatchOutput> {
  // SHE-19: dispatch has no classification complexity → defaults to small (Haiku).
  const selected = selectProvider(resolveModelClass({ callType: 'dispatch' }), input.chatId)
  // We need tool_choice='auto', not 'required' for a specific tool, so
  // we can't use callWithFailover<T>(tool, ...) directly — it assumes
  // a single named tool. We'll wire this via the AnthropicProvider
  // toolCall path but with a custom multi-tool invocation. Simpler:
  // do five separate callWithFailover calls with toolChoice='required'?
  // No — that doesn't model the "let Claude pick" semantic. Instead,
  // we route a single tool with a discriminated-union schema; the
  // model picks among the union variants via the discriminator
  // (`tool` field), and we dispatch on it server-side.

  // Closed-shape discriminated union via top-level 'tool' field. The
  // model sees a single tool 'dispatch_to_handler' with a oneOf-style
  // input where exactly one of the five branches is picked.
  // FLAT arg schema (M26 follow-up). The earlier design nested each tool's
  // args under a branch keyed by the tool name; the model reliably picked the
  // tool but kept leaving the nested branch EMPTY (it tends to emit args at the
  // top level — the natural tool-use shape), which the provider then stripped,
  // so every structural request fell through. Flattening the args to the top
  // level matches how the model wants to emit and makes the args land. Per-tool
  // required-field enforcement happens in validateBranchArgs (the flat schema
  // can't conditionally require fields per `tool`).
  const dispatchTool = {
    name: 'dispatch_to_handler',
    description:
      'Pick the handler in "tool", then fill the FLAT fields for THAT handler (e.g. region_replace → startMeasureIdx, endMeasureIdx, hint; extend_composition → targetBars; edit_intra_measure → targetDescription).',
    inputSchema: z.object({
      tool: z.enum(DispatchToolNames as unknown as [string, ...string[]]),
      targetBars: z.number().int().min(1).max(64).optional(),
      afterMeasureIdx: z.number().int().min(-1).optional(),
      count: z.number().int().min(1).max(64).optional(),
      startMeasureIdx: z.number().int().min(0).optional(),
      endMeasureIdx: z.number().int().min(0).optional(),
      hint: z.string().max(STRING_CAP).optional(),
      targetDescription: z.string().min(1).max(STRING_CAP).optional(),
      question: z.string().min(1).max(STRING_CAP).optional(),
      confirmExplicitRewrite: z.literal(true).optional(),
      justification: z.string().min(1).max(STRING_CAP).optional(),
    }),
    inputSchemaJson: {
      type: 'object',
      additionalProperties: false,
      required: ['tool'],
      properties: {
        tool: {
          type: 'string',
          enum: ['extend_composition', 'insert_measures', 'region_replace', 'edit_intra_measure', 'regenerate_all', 'answer_question'],
          description: 'Pick exactly one handler, then fill the fields for THAT handler below.',
        },
        targetBars: { type: 'integer', minimum: 1, maximum: 64, description: 'extend_composition: how many new bars to append at the END.' },
        afterMeasureIdx: { type: 'integer', minimum: -1, description: 'insert_measures: 0-based bar to insert AFTER (-1 = before bar 1).' },
        count: { type: 'integer', minimum: 1, maximum: 64, description: 'insert_measures: how many bars to insert.' },
        startMeasureIdx: { type: 'integer', minimum: 0, description: 'region_replace: first bar of the range to rewrite (0-based; bar 5 = index 4).' },
        endMeasureIdx: { type: 'integer', minimum: 0, description: 'region_replace: last bar of the range, INCLUSIVE (0-based; bar 8 = index 7).' },
        hint: { type: 'string', maxLength: 600, description: 'extend_composition / insert_measures / region_replace: description of the content to write (a sentence or two is plenty). REQUIRED for region_replace.' },
        targetDescription: { type: 'string', minLength: 1, maxLength: 600, description: 'edit_intra_measure: one-sentence description of the surgical edit.' },
        question: { type: 'string', minLength: 1, maxLength: 600, description: 'answer_question: the user question restated in one sentence.' },
        confirmExplicitRewrite: { type: 'boolean', enum: [true], description: 'regenerate_all: MUST be true; only when the user explicitly asked to start over.' },
        justification: { type: 'string', minLength: 1, maxLength: 600, description: 'regenerate_all: why you believe a full rewrite was requested.' },
      },
    },
  }

  const summary = input.editedScore
    ? buildScoreSummary(input.editedScore)
    : 'No score is currently loaded.'
  const userText = [
    `USER REQUEST: ${input.userText}`,
    ...(input.targetRegion ? ['', buildRegionHint(input.targetRegion)] : []),
    '',
    summary,
  ].join('\n')

  type DispatchToolInput = {
    tool: string
    targetBars?: number
    afterMeasureIdx?: number
    count?: number
    startMeasureIdx?: number
    endMeasureIdx?: number
    hint?: string
    targetDescription?: string
    question?: string
    confirmExplicitRewrite?: boolean
    justification?: string
  }
  try {
    const result = await callWithFailover<DispatchToolInput>(
      { ...selected, chatId: input.chatId },
      dispatchTool as unknown as import('@/lib/providers/types').ProviderTool<DispatchToolInput>,
      {
        systemPrompt: TOOL_DISPATCH_SYSTEM_PROMPT,
        userText,
        toolChoice: 'required',
        maxTokens: 300,
        temperature: 0,
        // Picking one tool from an enum needs no deep reasoning — keep it
        // cheap (Sonnet 4.6 would otherwise default to high effort).
        effort: 'low',
        thinking: 'disabled',
        modelOverride: input.modelOverride ?? selected.model,
        ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
        providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
      },
    )
    const parsed = result.input
    const tool = parsed.tool as DispatchToolName
    // Flat schema: the args live at the top level. Pass the whole object —
    // validateBranchArgs picks the fields for `tool` and strips the rest.
    return {
      tool,
      input: parsed,
      toolUseId: result.toolUseId,
      model: result.model,
      usage: result.usage ? {
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        outputTokens: result.usage.outputTokens,
      } : undefined,
    }
  } catch (e) {
    if (e instanceof ProviderSchemaError) {
      throw new ToolDispatchError(`tool dispatch failed: ${e.message}`)
    }
    throw e
  }
}

/**
 * Repair recoverable missing branch args before validation. The dispatcher
 * uses a discriminated union: the model sets `tool` and is supposed to fill
 * the matching branch object — but it sometimes picks the tool and leaves the
 * branch EMPTY (observed in prod: `extend_composition` with `args: undefined`,
 * which threw and dropped the turn to the slow unbounded legacy path).
 *
 * For tools with a SAFE default we fill it instead of failing the whole turn.
 * Tools whose missing fields can't be safely guessed (a wrong measure range or
 * an unconfirmed rewrite is worse than a clean retry) are left to throw.
 */
function repairBranchArgs(
  tool: DispatchToolName,
  args: unknown,
  userText: string,
): unknown {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  switch (tool) {
    case 'extend_composition':
      // Default to one short phrase; the per-tier clamp bounds it further.
      return {
        targetBars: typeof a.targetBars === 'number' ? a.targetBars : 4,
        ...(typeof a.hint === 'string' ? { hint: a.hint } : {}),
      }
    case 'edit_intra_measure':
      // Fall back to the user's own words as the edit description.
      return {
        targetDescription:
          typeof a.targetDescription === 'string' && a.targetDescription.trim().length > 0
            ? a.targetDescription
            : userText.slice(0, 500),
      }
    case 'answer_question':
      return {
        question:
          typeof a.question === 'string' && a.question.trim().length > 0
            ? a.question
            : userText.slice(0, 500),
      }
    case 'region_replace':
      // If the model gave a range but omitted the content hint, default it to
      // the user's own words — region_replace regenerates those bars FROM the
      // hint, and it's the right handler for "add a line to bars X-Y". Only the
      // range is unguessable; without it, fall through to the reroute.
      if (typeof a.startMeasureIdx === 'number' && typeof a.endMeasureIdx === 'number') {
        return {
          startMeasureIdx: a.startMeasureIdx,
          endMeasureIdx: a.endMeasureIdx,
          hint:
            typeof a.hint === 'string' && a.hint.trim().length > 0
              ? a.hint
              : userText.slice(0, 280),
        }
      }
      return args
    default:
      // insert_measures / regenerate_all — no safe default.
      return args
  }
}

/**
 * Per-tool zod validation of the branch args. Throws ToolDispatchError
 * on a parse failure (the model picked a tool but supplied malformed
 * args for that branch).
 */
function validateBranchArgs(
  tool: DispatchToolName,
  args: unknown,
): DispatchDecision['args'] {
  switch (tool) {
    case 'extend_composition': {
      const r = EXTEND_SCHEMA.safeParse(args)
      if (!r.success) throw new ToolDispatchError(`extend_composition args invalid: ${r.error.issues.map((i) => i.message).join('; ')}`)
      return r.data
    }
    case 'insert_measures': {
      const r = INSERT_SCHEMA.safeParse(args)
      if (!r.success) throw new ToolDispatchError(`insert_measures args invalid: ${r.error.issues.map((i) => i.message).join('; ')}`)
      return r.data
    }
    case 'region_replace': {
      const r = REGION_SCHEMA.safeParse(args)
      if (!r.success) throw new ToolDispatchError(`region_replace args invalid: ${r.error.issues.map((i) => i.message).join('; ')}`)
      return r.data
    }
    case 'edit_intra_measure': {
      const r = EDIT_INTRA_SCHEMA.safeParse(args)
      if (!r.success) throw new ToolDispatchError(`edit_intra_measure args invalid: ${r.error.issues.map((i) => i.message).join('; ')}`)
      return r.data
    }
    case 'regenerate_all': {
      const r = REGEN_SCHEMA.safeParse(args)
      if (!r.success) throw new ToolDispatchError(`regenerate_all args invalid: ${r.error.issues.map((i) => i.message).join('; ')}`)
      return r.data
    }
    case 'answer_question': {
      const r = ANSWER_QUESTION_SCHEMA.safeParse(args)
      if (!r.success) throw new ToolDispatchError(`answer_question args invalid: ${r.error.issues.map((i) => i.message).join('; ')}`)
      return r.data
    }
  }
}

/**
 * Public entry: invoke the dispatcher LLM, validate the picked tool +
 * args, return a DispatchDecision with a heuristic confidence (0.85
 * for explicit picks, 0.0 for refusals/timeouts). Documented
 * limitation: Anthropic doesn't expose log-probabilities so confidence
 * is coarse; future work may derive it from tool-call ambiguity
 * signals.
 */
export async function run(input: ToolDispatchInput): Promise<DispatchDecision> {
  const raw = await callDispatch(input)
  // Repair recoverable missing branch args (e.g. a tool pick with an empty
  // branch) before validating — keeps a model slip from dropping the turn to
  // the legacy path.
  const repaired = repairBranchArgs(raw.tool, raw.input, input.userText)
  try {
    const validatedArgs = validateBranchArgs(raw.tool, repaired)
    return {
      tool: raw.tool,
      args: validatedArgs,
      confidence: 0.85,
      model: raw.model,
      toolUseId: raw.toolUseId,
      ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
    }
  } catch (e) {
    if (!(e instanceof ToolDispatchError)) throw e
    // The model picked a structural tool but supplied args that don't validate
    // (commonly an empty branch — insert_measures with no afterMeasureIdx/count,
    // region_replace with no range). Rather than failing the turn — which drops
    // it to the slow whole-score legacy regen that has been emitting invalid
    // scores ("Measure 8: duration sum ...", "measures: expected array") — hand
    // the request to edit_intra_measure: the catch-all edit handler that does
    // surgical AND structural ops (insertMeasureAfter, dragMeasureRange,
    // deleteMeasure, ...) straight from the user's own words, on the bounded
    // path (insertMeasureAfter also fans out meter-correct rests). A botched
    // tool-pick becomes a best-effort edit instead of a hard failure.
    const fallbackArgs = validateBranchArgs('edit_intra_measure', {
      targetDescription: input.userText.slice(0, 500),
    })
    return {
      tool: 'edit_intra_measure',
      args: fallbackArgs,
      confidence: 0.6,
      model: raw.model,
      toolUseId: raw.toolUseId,
      ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
    }
  }
}

/** Exported for unit-test introspection. */
export const __TEST_TOOL_DISPATCH_PROMPT = TOOL_DISPATCH_SYSTEM_PROMPT
