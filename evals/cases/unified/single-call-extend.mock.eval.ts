import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Measure, Score } from '@/lib/music/types'
import { assertScoreInvariants } from '../../lib/assertions'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'

/**
 * SHE-19 PR2 — FREE-TIER single-call collapse, EXTEND path.
 *
 * With `SL_HAIKU_SINGLE_CALL=1` + free tier, the orchestrator routes the
 * whole edit through `runHaikuSingleCall`: ONE Haiku `tool_choice:'auto'`
 * call that BOTH picks the action AND emits the final ops, replacing the
 * 2-call dispatcher→handler path.
 *
 * THIS CASE: "add 4 more bars" on a 4-bar score. The single call returns a
 * `tool_use` for `emit_appended_bars` directly (no separate dispatcher call).
 * The unified result flows through `finalizeDispatchResult`, so the same
 * preservation invariants apply.
 *
 * MOCK SHAPE: exactly ONE Anthropic call (the unified multiToolCall). Unlike
 * the 2-call mock (dispatcher → handler), here a single `messages.create`
 * resolves to the emit tool_use.
 *
 * ASSERTS: 8 bars total, key=C / meter=4/4 / title preserved, bars 0-3
 * byte-identical (originals preserved), appliedOps contains `appendMeasures`
 * (the new bars were applied via the append op), failures.length === 0.
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

const { run: runOrchestrator } = await import('@/lib/orchestrator')

const TRIPLET_DEMO_4_BARS: Score = {
  title: 'Triplet demo',
  key: 'C',
  meter: '4/4',
  measures: [
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

/** Four bars of i-iv-V-(i) in C major as whole notes — the simplest valid
 *  4-bar turnaround for the mock emit. Musical richness is irrelevant; the
 *  invariants check structural preservation, not composition quality. */
const FOUR_TURNAROUND_BARS: Measure[] = [
  { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
  { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
]

/** A unified single-call `tool_use` response (stop_reason:'tool_use'). */
function singleCallToolUse(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_unified_${name}`, name, input }],
    usage: { input_tokens: 500, output_tokens: 600 },
  }
}

describe('eval: unified — single-call collapse EXTEND (SHE-19 PR2)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-eval-mock')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('EVAL_SILENT', '1')
    // Free tier + the single-call collapse flag → the unified path.
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
  })

  it('one unified call emits_appended_bars, appends 4 bars, preserves bars 0-3 (failures.length === 0)', async () => {
    // ONE Anthropic call: the unified multiToolCall returns the emit tool_use.
    anthropicCreateMock.mockResolvedValueOnce(
      singleCallToolUse('emit_appended_bars', { measures: FOUR_TURNAROUND_BARS }),
    )

    const outcome = await runOrchestrator({
      requestId: `eval_mock_unified_extend_${Date.now()}`,
      chatId: 'eval-mock-unified-extend',
      userText: 'add 4 more bars with a i iv v turnaround',
      editedScore: TRIPLET_DEMO_4_BARS,
      history: [],
      generationTier: 'free',
      tierPolicy: toTierPolicy('free'),
    })

    // Exactly one upstream call — the collapse, not the 2-call path.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)

    expect(
      outcome,
      'harness wiring broken: orchestrator did not return a score result',
    ).toMatchObject({ score: expect.anything() })

    const result =
      outcome && typeof outcome === 'object' && 'score' in outcome ? outcome : undefined
    expect(result?.dispatchTool).toBe('extend_composition')

    const failures = assertScoreInvariants(
      {
        afterScore: result?.score,
        appliedOps: result && 'appliedOps' in result ? result.appliedOps : undefined,
      },
      {
        measureCount: 8,
        keyPreserved: 'C',
        meterPreserved: '4/4',
        titlePreserved: 'Triplet demo',
        firstNMeasuresIdentical: 4,
        appliedOpsContain: 'appendMeasures',
      },
      TRIPLET_DEMO_4_BARS,
    )
    expect(failures, 'single-call extend invariant violations should be empty').toEqual([])
  })
})
