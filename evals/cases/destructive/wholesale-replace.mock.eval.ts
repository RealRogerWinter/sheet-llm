import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { assertScoreInvariants } from '../../lib/assertions'

/**
 * M3.5-PR-4 — second positive case in the suite. Validates the
 * replacement-as-confirmation gate fires when the AI returns a
 * wholesale replacement on a "make this jazz"-style prompt:
 *
 *   - user has a 4-bar Triplet demo on screen
 *   - prompt: "make this jazz" (no explicit-rewrite keywords)
 *   - mock provider returns an 8-bar score titled "Triplet Demo (Jazz)"
 *     in Bb major 4/4 — different bars, key + title changed, meter same.
 *
 * Expected: orchestrator marks the result `requiresConfirmation: true`
 * with `replacement.retainedIdentityRatio < 0.5` and `reasons[]`
 * containing the metadata changes. The eval uses the existing
 * `replacementBlocked` predicate from `evals/lib/assertions.ts`.
 *
 * This is the FIRST eval case targeted at the PR-4 gate.
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

/**
 * Wholesale "jazz" rewrite — different bars, different key + title,
 * meter intentionally preserved (some replacement-style LLM calls
 * keep meter; the gate must still fire on key+title alone).
 */
const JAZZ_REPLACEMENT_SCORE: Score = {
  title: 'Triplet Demo (Jazz)',
  key: 'Bb',
  meter: '4/4',
  measures: Array.from({ length: 8 }, () => ({
    events: [
      { pitches: [{ step: 'B', octave: 3, accidental: 'flat' }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
    ],
  })),
}

function legacySonnetReplacementResponse(score: Score): unknown {
  return {
    content: [
      {
        type: 'text',
        text: 'Here is a jazz reharmonization.',
      },
      {
        type: 'tool_use',
        id: 'toolu_compose_jazz_eval',
        name: 'render_score',
        input: score,
      },
    ],
    usage: { input_tokens: 350, output_tokens: 700 },
    stop_reason: 'tool_use',
  }
}

describe('eval: destructive — wholesale-replace gate (M3.5-PR-4)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-eval-mock')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('EVAL_SILENT', '1')
    // Force the LEGACY classifier+compose path so we hit the gate
    // through `runCompose` returning a wholesale replacement (the
    // production-incident shape). PR-6 flipped SL_NEW_TOOL_DISPATCH
    // to default-on; explicitly opt out here.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
  })

  it('flags wholesale "make this jazz" output as requiresConfirmation=true', async () => {
    // Two Anthropic calls expected:
    //   1. classifier → compose
    //   2. compose handler → emits wholesale jazz score
    // Order both via mockResolvedValueOnce so the order is explicit.
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_classify_jazz',
          name: 'classify',
          input: {
            kind: 'compose',
            scope: 'long',
            complexity: 'complex',
            confidence: 0.92,
          },
        },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
      stop_reason: 'tool_use',
    })
    anthropicCreateMock.mockResolvedValueOnce(
      legacySonnetReplacementResponse(JAZZ_REPLACEMENT_SCORE),
    )

    const outcome = await runOrchestrator({
      requestId: `eval_mock_wholesale_jazz_${Date.now()}`,
      chatId: 'eval-mock-wholesale-replace',
      userText: 'make this jazz',
      editedScore: TRIPLET_DEMO_4_BARS,
      history: [],
    })

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

    // The orchestrator marked it as requiring confirmation.
    expect(outcome.requiresConfirmation).toBe(true)
    expect(outcome.replacement).toBeDefined()
    expect(outcome.replacement!.retainedIdentityRatio).toBeLessThan(0.5)
    expect(outcome.replacement!.reasons.some((r) => r.includes('key C → Bb'))).toBe(true)
    expect(outcome.replacement!.reasons.some((r) => r.includes('Triplet'))).toBe(true)

    // The existing `replacementBlocked` invariant also passes.
    const failures = assertScoreInvariants(
      {
        afterScore: outcome.score,
        appliedOps: outcome.appliedOps,
        requiresConfirmation: outcome.requiresConfirmation,
      },
      { replacementBlocked: true },
      TRIPLET_DEMO_4_BARS,
    )
    expect(failures, 'replacementBlocked invariant should pass').toEqual([])
  })
})
