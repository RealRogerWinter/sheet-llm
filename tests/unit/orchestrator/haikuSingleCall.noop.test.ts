import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { TierPolicy } from '@/lib/orchestrator/types'

/**
 * SHE-19 follow-up — the free-tier single-call collapse must NOT silently
 * commit a no-op edit. When Haiku (under tool_choice:'auto') emits an edit that
 * doesn't actually change the score — empty ops, or replacement bars that echo
 * the originals (the documented "make it Dorian" regression) — `runHaikuSingleCall`
 * throws a recoverable HaikuSingleCallError so the orchestrator falls back to the
 * 2-call dispatch path instead of rendering "the same old score".
 *
 * A genuine PROSE question (the converse path) and a REAL edit are both
 * unaffected — the guard fires ONLY on a structural edit that changed nothing.
 */

const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {}
    static RateLimitError = class extends Error {}
    static APIUserAbortError = class extends Error {}
  }
  return { default: MockAnthropic }
})

const { runHaikuSingleCall, HaikuSingleCallError } = await import(
  '@/lib/orchestrator/haikuSingleCall'
)

const FREE_POLICY: TierPolicy = {
  allowSectional: false,
  allowWholeScore: false,
  maxBars: 4,
  emitCeiling: 2_600,
  useBoundedFallback: true,
}

/** A single 4/4 bar: C-D-E-F quarters. */
const ONE_BAR: Score = {
  title: 'One bar',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

function toolUse(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
    usage: { input_tokens: 400, output_tokens: 40 },
  }
}

function textReply(text: string): unknown {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 400, output_tokens: 20 },
  }
}

describe('runHaikuSingleCall — no-op edit guard (SHE-19 follow-up)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-noop')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('throws HaikuSingleCallError when edit_score emits empty ops (no change)', async () => {
    anthropicCreateMock.mockResolvedValue(toolUse('edit_score', { ops: [] }))
    await expect(
      runHaikuSingleCall({
        userText: 'make the third note a half note',
        editedScore: ONE_BAR,
        policy: FREE_POLICY,
      }),
    ).rejects.toBeInstanceOf(HaikuSingleCallError)
  })

  it('throws when emit_replacement_bars echoes the original bars unchanged', async () => {
    // "make it Dorian" — the model returns the SAME notes (the documented
    // whole-piece-transform regression). The applied score equals the original.
    anthropicCreateMock.mockResolvedValue(
      toolUse('emit_replacement_bars', {
        startMeasureIdx: 0,
        endMeasureIdx: 0,
        measures: [
          {
            events: [
              { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
              { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
              { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
              { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            ],
          },
        ],
      }),
    )
    await expect(
      runHaikuSingleCall({
        userText: 'make this Dorian',
        editedScore: ONE_BAR,
        policy: FREE_POLICY,
      }),
    ).rejects.toBeInstanceOf(HaikuSingleCallError)
  })

  it('still returns a converse result (unchanged score) for a genuine prose question', async () => {
    anthropicCreateMock.mockResolvedValue(textReply('This piece is in C major.'))
    const res = await runHaikuSingleCall({
      userText: 'what key is this?',
      editedScore: ONE_BAR,
      policy: FREE_POLICY,
    })
    expect(res.score).toEqual(ONE_BAR)
    expect(res.introText).toContain('C major')
    expect(res.dispatchTool).toBeUndefined()
  })

  it('still applies and returns a REAL edit (the guard is no-op-only)', async () => {
    anthropicCreateMock.mockResolvedValue(
      toolUse('edit_score', {
        ops: [
          { kind: 'changeDuration', target: { measureIdx: 0, eventIdx: 2 }, duration: 'half' },
          { kind: 'deleteEvent', target: { measureIdx: 0, eventIdx: 3 } },
        ],
      }),
    )
    const res = await runHaikuSingleCall({
      userText: 'make the third note a half note',
      editedScore: ONE_BAR,
      policy: FREE_POLICY,
    })
    expect(res.dispatchTool).toBe('edit_intra_measure')
    expect(res.score.measures[0].events).toHaveLength(3)
    expect(res.score.measures[0].events[2]).toMatchObject({ duration: 'half' })
  })
})
