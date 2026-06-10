import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'

/**
 * SHE-19 PR2 — FREE-TIER single-call collapse, TEXT / ANSWER branch.
 *
 * Under `tool_choice:'auto'`, a pure QUESTION about the score ("what key is
 * this?") gets a plain-TEXT reply and NO tool call. `runHaikuSingleCall` maps
 * that to a converse-style `OrchestratorResult`: the prose lands on
 * `introText`, the classification kind is `converse`, and the score is returned
 * UNCHANGED (no mutation, no appliedOps, no dispatchTool).
 *
 * ASSERTS: exactly one upstream call; the reply text is surfaced; the score is
 * byte-identical to the input; classification.kind === 'converse'; no
 * dispatchTool / appliedOps; the result is NOT gated (requiresConfirmation
 * falsy — nothing changed to confirm).
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

const ONE_BAR: Score = {
  title: 'One bar',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

const ANSWER_TEXT = 'This is in C major — a C-major arpeggio (C-E-G-C) over one bar.'

/** A prose reply: stop_reason:'end_turn', text blocks, NO tool_use. */
function singleCallTextReply(text: string): unknown {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 420, output_tokens: 30 },
  }
}

describe('eval: unified — single-call collapse TEXT/ANSWER branch (SHE-19 PR2)', () => {
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

  it('a plain-text reply becomes a converse result; score is unchanged', async () => {
    anthropicCreateMock.mockResolvedValueOnce(singleCallTextReply(ANSWER_TEXT))

    const outcome = await runOrchestrator({
      requestId: `eval_mock_unified_answer_${Date.now()}`,
      chatId: 'eval-mock-unified-answer',
      userText: 'what key is this?',
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
      'outcomeKind' in outcome ||
      !('score' in outcome)
    ) {
      throw new Error('expected OrchestratorResult (converse-style)')
    }

    // The prose answer is surfaced.
    expect(outcome.introText).toBe(ANSWER_TEXT)
    expect(outcome.classification.kind).toBe('converse')

    // The score is returned UNCHANGED — no mutation, no ops, no dispatch tool.
    expect(outcome.score).toEqual(ONE_BAR)
    expect(outcome.appliedOps).toBeUndefined()
    expect(outcome.dispatchTool).toBeUndefined()

    // Nothing changed → no confirmation gate.
    expect(outcome.requiresConfirmation).toBeFalsy()
    expect(outcome.replacement).toBeUndefined()
  })
})
