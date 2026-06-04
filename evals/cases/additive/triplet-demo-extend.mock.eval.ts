import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Measure, Score } from '@/lib/music/types'
import { assertScoreInvariants } from '../../lib/assertions'

/**
 * M3.5-PR-3 fix verified — the bug repro now PASSES.
 *
 * INCIDENT (2026-05-25, session d9aedf07-cfec-4312-a37d-a181b5e23fb9):
 *   User had a 4-bar Triplet demo open and prompted:
 *     "add 4 more bars with a i iv v turnaround"
 *   The orchestrator returned a brand-new 5/4 Am piece titled
 *   "5/4 ostinato" — full silent replacement of user work.
 *
 * THE FIX (M3.5-PR-3): native tool-use dispatch replaces the Haiku
 * intent classifier with a Claude tool-pick over five tools. For
 * "add N more bars" it picks `extend_composition` which forcibly
 * inherits key/meter/title (the tool schema has no such fields),
 * appends only the new measures, and verifies server-side that every
 * original measure hashes identically post-application.
 *
 * PR-6: the dispatcher is now default-on. This case no longer needs
 * to set `SL_NEW_TOOL_DISPATCH=1` — the orchestrator picks the new
 * path by default. `buildLiveCase` still sets the flag for the live
 * tier as defense-in-depth.
 *
 * WHAT THIS TEST DOES NOW:
 *   - First Anthropic call (dispatcher): returns
 *     tool=extend_composition, targetBars=4.
 *   - Second Anthropic call (extend handler): returns 4 new C-major
 *     bars via emit_appended_bars.
 *   - Asserts invariants: 8 bars total, key=C / meter=4/4 / title
 *     preserved, bars 0-3 byte-identical, appliedOps contains
 *     `appendMeasures` (the underlying Operation kind that
 *     extend_composition emits).
 *
 * The failures array is EMPTY when the fix holds.
 */

const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {}
    static RateLimitError = class extends Error {}
  }
  return { default: MockAnthropic }
})

// Dynamic import to defer module load until after vi.mock is hoisted.
const { run: runOrchestrator } = await import('@/lib/orchestrator')

/**
 * The initial 4-bar Triplet demo score the user had on screen.
 * Hand-authored to match the ABC source-of-truth at
 * src/components/DebugPanel.tsx (2 bars), extended to 4 bars to
 * reflect the user's edited state at incident time.
 *
 * Two original bars: (3CDE F2 G2 A2 | (3DEF G2 A2 B2 |
 * Two added bars: (3EFG A2 B2 c2 | (3FGA B2 c2 d2 |
 * (Continuing the same triplet-into-three-quarters pattern.)
 */
const TRIPLET_DEMO_4_BARS: Score = {
  title: 'Triplet demo',
  key: 'C',
  meter: '4/4',
  measures: [
    // Bar 0: (3 C D E F G A → triplet eighths CDE then F,G,A as quarters.
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      ],
    },
    // Bar 1: (3 D E F G A B
    {
      events: [
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      ],
    },
    // Bar 2 (user-added): (3 E F G A B c
    {
      events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    // Bar 3 (user-added): (3 F G A B c d
    {
      events: [
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

/**
 * What the production model ACTUALLY returned — a wholesale
 * replacement in 5/4 Am titled "5/4 ostinato". 8 measures of
 * unrelated content (4 instead of the expected 4+4 extension).
 * The exact event content isn't important — what's important is
 * that this Score completely fails our preservation invariants,
 * which is the bug we're capturing.
 */
const REGRESSION_REPLACEMENT_SCORE: Score = {
  title: '5/4 ostinato',
  key: 'Am',
  meter: '5/4',
  tempo_bpm: 100,
  measures: Array.from({ length: 8 }, () => ({
    events: [
      { pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ],
  })),
}

interface Case {
  id: string
  intent: 'additive'
  userText: string
  initialScore: Score
  expected: Parameters<typeof assertScoreInvariants>[1]
}

const TRIPLET_DEMO_EXTEND_CASE: Case = {
  id: 'triplet-demo-extend-4-bars-i-iv-v',
  intent: 'additive',
  userText: 'add 4 more bars with a i iv v turnaround',
  initialScore: TRIPLET_DEMO_4_BARS,
  expected: {
    measureCount: 8,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Triplet demo',
    firstNMeasuresIdentical: 4,
    // The structural op the extend_composition handler emits is
    // `appendMeasures` — that's what appliedOps[0].kind will be.
    // The dispatch tool name `extend_composition` is recorded as
    // dispatchTool on the result envelope.
    appliedOpsContain: 'appendMeasures',
  },
}

/**
 * Four bars of i-iv-V-(i) in C major as whole notes — the simplest
 * valid 4-bar i-iv-V turnaround for the mock response. The musical
 * "richness" is irrelevant here: invariants check structural
 * preservation, not composition quality.
 */
const FOUR_TURNAROUND_BARS: Measure[] = [
  { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
]

function dispatchResponse(tool: string, args: Record<string, unknown>): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_dispatch_eval',
        name: 'dispatch_to_handler',
        input: { tool, [tool]: args },
      },
    ],
    usage: { input_tokens: 250, output_tokens: 40 },
  }
}

function emitAppendedBarsResponse(measures: Measure[]): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_emit_eval',
        name: 'emit_appended_bars',
        input: { measures },
      },
    ],
    usage: { input_tokens: 400, output_tokens: 600 },
  }
}

describe('eval: additive — triplet demo extend (M3.5-PR-3 fix verified)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-eval-mock')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('EVAL_SILENT', '1')
    // Since PR-6 the dispatcher is default-on; no env stub needed.
  })

  it('extend_composition appends 4 bars, preserves bars 0-3, key/meter/title intact (failures.length === 0)', async () => {
    // First Anthropic call: the new tool dispatcher picks
    // extend_composition with targetBars=4.
    anthropicCreateMock.mockResolvedValueOnce(
      dispatchResponse('extend_composition', {
        targetBars: 4,
        hint: 'i-iv-V turnaround',
      }),
    )
    // Second Anthropic call: extend handler's emit_appended_bars
    // returns the 4 new bars.
    anthropicCreateMock.mockResolvedValueOnce(
      emitAppendedBarsResponse(FOUR_TURNAROUND_BARS),
    )

    const outcome = await runOrchestrator({
      requestId: `eval_mock_${TRIPLET_DEMO_EXTEND_CASE.id}_${Date.now()}`,
      chatId: 'eval-mock-triplet-demo',
      userText: TRIPLET_DEMO_EXTEND_CASE.userText,
      editedScore: TRIPLET_DEMO_EXTEND_CASE.initialScore,
      history: [],
    })

    expect(
      outcome,
      'harness wiring broken: orchestrator did not return a score result',
    ).toMatchObject({ score: expect.anything() })

    const failures = assertScoreInvariants(
      {
        afterScore:
          outcome && typeof outcome === 'object' && 'score' in outcome
            ? outcome.score
            : undefined,
        appliedOps:
          outcome && typeof outcome === 'object' && 'appliedOps' in outcome
            ? outcome.appliedOps
            : undefined,
      },
      TRIPLET_DEMO_EXTEND_CASE.expected,
      TRIPLET_DEMO_EXTEND_CASE.initialScore,
    )

    // The fix holds: invariant violations array is empty.
    expect(failures, 'invariant violations after the fix should be empty').toEqual([])
  })

  // Defensive: keep REGRESSION_REPLACEMENT_SCORE referenced so future
  // edits to the case can re-use it as a pre-PR-3 baseline if needed.
  void REGRESSION_REPLACEMENT_SCORE
})
