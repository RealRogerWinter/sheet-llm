import type { Score } from '@/lib/music/types'
import type { ChatMessage } from '@/lib/llm/wrapper'
import { selectProvider } from '@/lib/providers/select'
import type { TextStreamEvent } from '@/lib/providers/types'
import type { Classification, OrchestratorConverseStream } from '../types'
import { isStreamAbortEnabled } from '../flags'

const MAX_TOKENS = 4_000 // M25-PR-6: raised from 1500 so longer theory answers don't truncate mid-sentence (text, not render_score)
// M26 PR-2: wall-clock ceiling for the streaming kill-switch (SL_STREAM_ABORT).
// A text answer rarely needs this long; it cuts off a stuck/runaway stream that
// max_tokens alone can't bound by time.
const STREAM_WALL_CLOCK_MS = 90_000

const CONVERSE_SYSTEM_PROMPT = `You are a music tutor. The user has a score in front of them and is asking a question about it (music theory, analysis, identification, or a "why does this work" explanation). Answer concisely in well-formed markdown.

STYLE:
- Use **bold** for the answer headline and short bullet lists for supporting points.
- Note names use scientific pitch notation (C4 = middle C, G#5, Bb3).
- Reference specific measures and events by their 0-based index (e.g. "measure 2, event 0") when pointing at the score.
- For chord names, give both the symbol (Cmaj7, D7) and the constituent notes.
- GFM tables are OK for genuine column data (e.g. comparing chord qualities, listing scale degrees). Prefer bullet lists for short enumerations.
- Keep answers under ~250 words unless the user explicitly asks for depth.

MULTI-STAFF / MULTI-VOICE SCORES:
- If the score has a \`secondStaff\` field, it's a grand-staff (piano two-hand) or SATB layout. The primary \`measures\` is the top staff (typically right hand / Soprano-Alto); \`secondStaff.measures\` is the bottom staff (typically left hand / Tenor-Bass).
- If a staff has \`extraVoices\`, those are independent simultaneous voices on the same staff. Voice 0 is the primary (\`measures\`); voices 1..N are \`extraVoices\` entries. SATB convention: staff 0 voice 0 = Soprano, staff 0 voice 1 = Alto, staff 1 voice 0 = Tenor, staff 1 voice 1 = Bass.
- When the user asks about a specific voice ("what's the alto doing?", "the bass line in measure 3"), look at the right voice's measures — NOT the primary if they named another voice. Identify the voice by SATB convention or by clef context (treble vs bass).
- When referencing notes, include the voice name where useful: "alto, measure 3, event 2 = G4" reads better than just "measure 3 event 2".

DO NOT:
- Render staff notation as ASCII art. No pseudo-staff diagrams with dashes, bars, slashes, or fixed-width column attempts (e.g. \`—5—7—8—\`, \`| C | D | E |\` as a make-believe staff, monospace rhythm grids). The user already sees the rendered score above the chat — describe in prose with note names + measure indices instead.
- Emit ABC notation, MusicXML, LilyPond, or any other notation snippet in code blocks. The user cannot play those inline. If they want a new score, point them to send it as a generate/edit request.
- Use LaTeX/math notation (\`$...$\`, \`\\\\frac\`, etc.) — it won't render.
- Propose edits to the score — a different handler covers that. If the user pivots to wanting a change, end with "Send that as an edit request and I'll apply it."
- Invent notes that aren't in the supplied JSON. If the question can't be answered from the score, say so.
- Use a tool call. Reply in plain markdown text.
`

export interface RunConverseInput {
  classification: Classification
  chatId: string
  /** Original user prompt. Verbatim because the question's phrasing
   *  matters (the classifier's `question` field is a summary). */
  userText: string
  /** Guaranteed by classifier gating: converse is never dispatched
   *  without a score. The handler asserts and falls through otherwise. */
  editedScore: Score
  history: ReadonlyArray<ChatMessage>
  modelOverride?: string
  apiKeyOverride?: string
}

/**
 * Build the user-turn text for the converse handler. Includes the
 * current score so the model can answer questions grounded in actual
 * notes/measures/keys.
 */
function buildUserText(userText: string, score: Score): string {
  return `${userText}\n\nCURRENT SCORE (JSON):\n${JSON.stringify(score, null, 2)}`
}

/**
 * runConverse — returns a streaming AsyncIterable wrapped in an
 * OrchestratorConverseStream. The handler does NOT consume the stream;
 * the route owns lifecycle so it can persist accumulated text on stop /
 * error / client-abort.
 *
 * Tier: 'medium' (Sonnet 4.6) — matches edit_intra_measure. Music
 * theory answers benefit from Sonnet over Haiku without needing Opus.
 */
export function runConverse(input: RunConverseInput): OrchestratorConverseStream {
  const t0 = Date.now()
  const selected = selectProvider('medium', input.chatId)

  if (!selected.provider.textStream) {
    throw new Error(
      `Provider ${selected.providerName} does not support text streaming; cannot serve converse intent.`,
    )
  }

  const events = selected.provider.textStream({
    systemPrompt: CONVERSE_SYSTEM_PROMPT,
    userText: buildUserText(input.userText, input.editedScore),
    maxTokens: MAX_TOKENS,
    // Music-theory chat: medium effort balances quality vs. cost, and a
    // conversational reply doesn't need extended thinking.
    effort: 'medium',
    thinking: 'disabled',
    modelOverride: input.modelOverride ?? selected.model,
    ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
    // M26 PR-2: opt-in streaming kill-switch — abort if the answer overruns the
    // token budget or the wall-clock deadline. OFF unless SL_STREAM_ABORT is set.
    ...(isStreamAbortEnabled()
      ? { outputTokenBudget: MAX_TOKENS, streamDeadlineAt: Date.now() + STREAM_WALL_CLOCK_MS }
      : {}),
    providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
  }) as AsyncIterable<TextStreamEvent>

  return {
    outcomeKind: 'converse_stream',
    classification: input.classification,
    model: input.modelOverride ?? selected.model,
    events,
    chatId: input.chatId,
    latencyMs: Date.now() - t0,
  }
}
