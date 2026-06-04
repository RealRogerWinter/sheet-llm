import type { LLMClient, LLMCompleteRequest, LLMResponse } from './wrapper'
import type { Score } from '@/lib/music/types'

const STUB_SCORE_C: Score = {
  title: 'Stub C major scale',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
    { events: [
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ] },
  ],
}

/**
 * Grand-staff (piano) stub fixture. Two bars of Twinkle Twinkle with
 * a chord accompaniment in the bass staff. Used by stub-mode tests +
 * dev to exercise the multi-staff render/edit pipeline without a real
 * LLM call.
 */
const STUB_SCORE_PIANO: Score = {
  title: 'Stub piano (Twinkle Twinkle, 2 bars)',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
    ] },
    { events: [
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
    ] },
  ],
  secondStaff: {
    clef: 'bass',
    measures: [
      { events: [
        { pitches: [{ step: 'C', octave: 3 }, { step: 'E', octave: 3 }, { step: 'G', octave: 3 }], duration: 'whole' },
      ] },
      { events: [
        { pitches: [{ step: 'F', octave: 2 }, { step: 'A', octave: 3 }, { step: 'C', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'C', octave: 3 }, { step: 'E', octave: 3 }, { step: 'G', octave: 3 }], duration: 'half' },
      ] },
    ],
  },
}

/**
 * SATB stub fixture. 2 bars; soprano/alto on the treble staff,
 * tenor/bass on the bass staff. Cadential I-IV-V-I progression.
 */
const STUB_SCORE_SATB: Score = {
  title: 'Stub SATB (cadence in C, 2 bars)',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'G', octave: 4 }], duration: 'half' }, // Soprano
      { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
    ] },
    { events: [
      { pitches: [{ step: 'E', octave: 4 }], duration: 'whole' },
    ] },
  ],
  extraVoices: [
    { measures: [
      { events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'half' }, // Alto
        { pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
      ] },
      { events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ] },
    ] },
  ],
  secondStaff: {
    clef: 'bass',
    measures: [
      { events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' }, // Tenor
        { pitches: [{ step: 'B', octave: 3 }], duration: 'half' },
      ] },
      { events: [
        { pitches: [{ step: 'G', octave: 3 }], duration: 'whole' },
      ] },
    ],
    extraVoices: [
      { measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'half' }, // Bass
          { pitches: [{ step: 'G', octave: 2 }], duration: 'half' },
        ] },
        { events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
        ] },
      ] },
    ],
  },
}

const STUB_SCORE_G: Score = {
  title: 'Stub G major scale (refined)',
  key: 'G',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ] },
    { events: [
      { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 5, accidental: 'sharp' }], duration: 'quarter' },
      { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
    ] },
  ],
}

function lastUserTextOf(req: LLMCompleteRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]
    if (m.role !== 'user') continue
    for (const block of m.content) {
      if (block.type === 'text') return block.text
    }
  }
  return undefined
}

function isRefinement(req: LLMCompleteRequest): boolean {
  return req.messages.some((m) =>
    m.role === 'user' && m.content.some((c) => c.type === 'tool_result'),
  )
}

/**
 * Detect a manual-edit refinement: the user turn's tool_result
 * content carries the edited Score (encoded as JSON text by
 * buildUserTurnForRefinement). Returns the embedded score if found.
 */
function lastEditedScoreInToolResult(req: LLMCompleteRequest): Score | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]
    if (m.role !== 'user') continue
    for (const block of m.content) {
      if (block.type !== 'tool_result') continue
      const content = block.content
      if (typeof content === 'string' && content.includes('manually edited')) {
        // Extract the JSON block between '{' and the trailing '}'.
        const start = content.indexOf('{')
        const end = content.lastIndexOf('}')
        if (start >= 0 && end > start) {
          try {
            return JSON.parse(content.slice(start, end + 1)) as Score
          } catch {
            return undefined
          }
        }
      }
    }
  }
  return undefined
}

export const stubClient: LLMClient = {
  async complete(req: LLMCompleteRequest): Promise<LLMResponse> {
    const editedScore = lastEditedScoreInToolResult(req)
    const lastText = lastUserTextOf(req)

    // If the user sent an edit, echo it with a title marker so the
    // frontend can verify "the stub saw my edit" without a real API key.
    if (editedScore) {
      return {
        score: {
          ...editedScore,
          title: `${editedScore.title ?? 'Untitled'} (stub-acknowledged-edit)`,
        },
        introText: `Stub acknowledged your edit. Got: "${lastText ?? 'no message'}".`,
        toolUseId: `toolu_stub_${crypto.randomUUID()}`,
      }
    }

    // Multi-staff trigger words. Word-boundary regex so we don't fire
    // STUB_SCORE_PIANO on "play this piano scale" (which is a test
    // fixture for the C-major-scale flow). SATB matches first so a
    // prompt like "SATB piano arrangement" hits SATB instead of the
    // narrower grand-staff fixture.
    if (lastText && /\b(satb|choral|four[-\s]?part|hymn)\b/i.test(lastText)) {
      return {
        score: STUB_SCORE_SATB,
        introText: `Stub SATB cadence. Got: "${lastText}".`,
        toolUseId: `toolu_stub_${crypto.randomUUID()}`,
      }
    }
    if (lastText && /\b(piano|grand\s*staff|two[-\s]?hand)\b/i.test(lastText)) {
      return {
        score: STUB_SCORE_PIANO,
        introText: `Stub grand-staff piano. Got: "${lastText}".`,
        toolUseId: `toolu_stub_${crypto.randomUUID()}`,
      }
    }

    const refining = isRefinement(req)
    const score = refining ? STUB_SCORE_G : STUB_SCORE_C
    return {
      score,
      introText: refining
        ? `Stub refined response (transposed to G). Got: "${lastText ?? 'no message'}".`
        : `Stub response (Claude not wired yet — Phase 4). Got: "${lastText ?? 'no message'}".`,
      toolUseId: `toolu_stub_${crypto.randomUUID()}`,
    }
  },
}
