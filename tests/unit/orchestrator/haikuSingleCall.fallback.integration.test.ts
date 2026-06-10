import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Measure, Score } from '@/lib/music/types'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'

/**
 * SHE-19 follow-up — END-TO-END wiring: a free-tier single-call edit that
 * changes nothing must fall through to the 2-call dispatch path, NOT silently
 * commit the unchanged score. This pins the load-bearing catch in `index.ts`
 * (a `HaikuSingleCallError` is recoverable → falls back, NOT rethrown) against a
 * REAL `runHaikuSingleCall` no-op (only the Anthropic SDK is mocked).
 *
 * Sequence of mocked upstream calls:
 *   1. single call (tool_choice:'auto') → edit_score with EMPTY ops (no change)
 *      → runHaikuSingleCall throws HaikuSingleCallError → orchestrator falls back.
 *   2. dispatcher (dispatch_to_handler) → picks extend_composition.
 *   3. extend handler (emit_appended_bars) → appends one real bar.
 * Result: the appended bar IS applied (2 measures), proving the fallback ran.
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
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

function singleCallToolUse(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_unified_${name}`, name, input }],
    usage: { input_tokens: 450, output_tokens: 20 },
  }
}

function dispatchResponse(tool: string, args: Record<string, unknown>): unknown {
  return {
    content: [
      { type: 'tool_use', id: 'toolu_dispatch', name: 'dispatch_to_handler', input: { tool, [tool]: args } },
    ],
    usage: { input_tokens: 250, output_tokens: 40 },
  }
}

function emitAppendedBarsResponse(measures: Measure[]): unknown {
  return {
    content: [{ type: 'tool_use', id: 'toolu_emit', name: 'emit_appended_bars', input: { measures } }],
    usage: { input_tokens: 400, output_tokens: 120 },
  }
}

describe('single-call no-op edit → 2-call fallback (SHE-19 follow-up, e2e)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-fallback')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('EVAL_SILENT', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
  })

  it('a no-op single-call edit falls back to the 2-call path, which applies a real edit', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(singleCallToolUse('edit_score', { ops: [] })) // no-op → throws
      .mockResolvedValueOnce(dispatchResponse('extend_composition', { targetBars: 1, hint: 'one more bar' }))
      .mockResolvedValueOnce(
        emitAppendedBarsResponse([
          { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
        ]),
      )

    const outcome = await runOrchestrator({
      requestId: `eval_fallback_${Date.now()}`,
      chatId: 'fallback-e2e',
      userText: 'add one more bar',
      editedScore: ONE_BAR,
      history: [],
      generationTier: 'free',
      tierPolicy: toTierPolicy('free'),
    })

    if (!outcome || typeof outcome !== 'object' || 'refused' in outcome || 'fellThrough' in outcome || 'outcomeKind' in outcome) {
      throw new Error('expected an OrchestratorResult, got: ' + JSON.stringify(outcome)?.slice(0, 200))
    }

    // The single call ran (1) and no-opped → fell back to dispatcher (2) + handler (3).
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3)
    // The fallback applied a REAL edit: the bar was appended (NOT the same old score).
    expect(outcome.score.measures.length).toBe(2)
    expect(outcome.dispatchTool).toBe('extend_composition')
  })
})
