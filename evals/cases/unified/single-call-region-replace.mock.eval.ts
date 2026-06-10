import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Measure, Score } from '@/lib/music/types'
import { assertScoreInvariants } from '../../lib/assertions'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'

/**
 * SHE-19 PR2 — FREE-TIER single-call collapse, REGION_REPLACE path.
 *
 * "rewrite bars 3-4" on a 4-bar score. The unified call returns a single
 * `tool_use` for `emit_replacement_bars` carrying the inclusive 0-based range
 * (startMeasureIdx/endMeasureIdx) INLINE — no separate dispatcher call to pick
 * the range. The region apply replaces exactly that range; bars OUTSIDE the
 * range are preserved.
 *
 * ASSERTS:
 *   - the region CHANGED: bars 0-1 (outside the range) are byte-identical,
 *     measure count unchanged (2 replaced by 2), key/meter/title intact.
 *   - the gate/preservation behavior: the result flows through
 *     `finalizeDispatchResult`, and a same-key, same-title, in-range rewrite
 *     does NOT trip the replacement-as-confirmation gate
 *     (`requiresConfirmation` stays falsy) — the user's work is mostly retained.
 *   - `dispatchTool === 'region_replace'`, appliedOps contains `regionReplace`.
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

const FOUR_BAR_SCALE: Score = {
  title: 'Ascending scale',
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
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'A', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 6 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 6 }], duration: 'quarter' },
      ],
    },
  ],
}

/** Two replacement bars for the range [2..3] — a descending tail instead of
 *  the original ascending scale. Different content, valid 4/4. */
const REPLACEMENT_BARS: Measure[] = [
  {
    events: [
      { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 5 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
    ],
  },
  {
    events: [
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
    ],
  },
]

function singleCallToolUse(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_unified_${name}`, name, input }],
    usage: { input_tokens: 500, output_tokens: 400 },
  }
}

describe('eval: unified — single-call collapse REGION_REPLACE (SHE-19 PR2)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-eval-mock')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('EVAL_SILENT', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
    // Isolate the REPLACEMENT gate: ghost preview (default-on) attaches a
    // proposal + requiresConfirmation on any in-range diff, which would mask
    // whether the replacement gate itself fired. Turn it off so the only
    // confirmation signal here is the replacement gate.
    vi.stubEnv('SL_GHOST_PREVIEW', '0')
  })

  it('one unified call replaces bars 3-4 inline, preserves bars 1-2, does not trip the gate', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      singleCallToolUse('emit_replacement_bars', {
        startMeasureIdx: 2,
        endMeasureIdx: 3,
        measures: REPLACEMENT_BARS,
      }),
    )

    const outcome = await runOrchestrator({
      requestId: `eval_mock_unified_region_${Date.now()}`,
      chatId: 'eval-mock-unified-region',
      userText: 'rewrite bars 3-4 as a descending line',
      editedScore: FOUR_BAR_SCALE,
      history: [],
      generationTier: 'free',
      tierPolicy: toTierPolicy('free'),
    })

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    expect(
      outcome,
      'harness wiring broken: orchestrator did not return a score result',
    ).toMatchObject({ score: expect.anything() })
    if (
      !outcome ||
      typeof outcome !== 'object' ||
      'refused' in outcome ||
      'fellThrough' in outcome ||
      'outcomeKind' in outcome
    ) {
      throw new Error('expected OrchestratorResult')
    }

    expect(outcome.dispatchTool).toBe('region_replace')

    // The region actually changed: bar 2 (index 2) is no longer the original
    // ascending D5-E5-F5-G5.
    const changedBar = outcome.score.measures[2]
    expect(changedBar.events[0].pitches[0]).toMatchObject({ step: 'G', octave: 5 })

    // Same-range rewrite that keeps key/meter/title and >half the bars must NOT
    // trip the replacement-as-confirmation gate (ghost preview is off here, so
    // requiresConfirmation reflects ONLY the gate).
    expect(outcome.requiresConfirmation).toBeFalsy()
    expect(outcome.replacement).toBeUndefined()

    const failures = assertScoreInvariants(
      {
        afterScore: outcome.score,
        appliedOps: outcome.appliedOps,
      },
      {
        measureCount: 4,
        keyPreserved: 'C',
        meterPreserved: '4/4',
        titlePreserved: 'Ascending scale',
        // Bars outside the replaced range stay byte-identical.
        firstNMeasuresIdentical: 2,
        appliedOpsContain: 'regionReplace',
      },
      FOUR_BAR_SCALE,
    )
    expect(failures, 'single-call region-replace invariant violations should be empty').toEqual([])
  })
})
