import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'

/**
 * SHE-19 PR2 — FREE-TIER single-call collapse, INTRA edit path.
 *
 * "make the third note a quarter" on a 1-bar score. The unified call returns a
 * single `tool_use` for `edit_score` whose `ops` array is the minimal
 * Operation list. The single-call path applies each op via `transformScore`,
 * validates, and returns `appliedOps` directly (no second handler call).
 *
 * ASSERTS: exactly one upstream call; `dispatchTool === 'edit_intra_measure'`;
 * appliedOps equals the emitted ops; the targeted note actually changed
 * (E quarter → E half) while the rest of the bar is intact.
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

/** A single 4/4 bar: C-D-E-F as quarters. We turn the third note (E, eventIdx
 *  2) into a half and drop the trailing F so the bar still sums to 4/4. */
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

/** Minimal ops: lengthen the third note to a half, delete the now-overflowing
 *  fourth note. Keeps the bar at 4 beats. */
const EDIT_OPS = [
  { kind: 'changeDuration', target: { measureIdx: 0, eventIdx: 2 }, duration: 'half' },
  { kind: 'deleteEvent', target: { measureIdx: 0, eventIdx: 3 } },
]

function singleCallToolUse(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_unified_${name}`, name, input }],
    usage: { input_tokens: 450, output_tokens: 60 },
  }
}

describe('eval: unified — single-call collapse INTRA edit (SHE-19 PR2)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-eval-mock')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('EVAL_SILENT', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
  })

  it('one unified call emits edit_score ops, applies them, returns appliedOps', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      singleCallToolUse('edit_score', { ops: EDIT_OPS }),
    )

    const outcome = await runOrchestrator({
      requestId: `eval_mock_unified_intra_${Date.now()}`,
      chatId: 'eval-mock-unified-intra',
      userText: 'make the third note a half note',
      editedScore: ONE_BAR,
      history: [],
      generationTier: 'free',
      tierPolicy: toTierPolicy('free'),
    })

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    if (
      !outcome ||
      typeof outcome !== 'object' ||
      'refused' in outcome ||
      'fellThrough' in outcome ||
      'outcomeKind' in outcome
    ) {
      throw new Error('expected OrchestratorResult')
    }

    expect(outcome.dispatchTool).toBe('edit_intra_measure')

    // The emitted ops were applied verbatim.
    expect(outcome.appliedOps).toEqual(EDIT_OPS)

    // The targeted note (E, index 2) is now a half; the bar has 3 events.
    const bar = outcome.score.measures[0]
    expect(bar.events).toHaveLength(3)
    expect(bar.events[2]).toMatchObject({
      duration: 'half',
      pitches: [{ step: 'E', octave: 4 }],
    })
    // Key / meter / title untouched.
    expect(outcome.score.key).toBe('C')
    expect(outcome.score.meter).toBe('4/4')
    expect(outcome.score.title).toBe('One bar')
  })
})
