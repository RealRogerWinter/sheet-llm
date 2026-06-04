import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const VALID_SCORE: Score = {
  title: 'OK',
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

const { runCompose, _resetComposeClient } = await import(
  '@/lib/orchestrator/handlers/compose'
)

const BASE_CLASSIFICATION = {
  kind: 'compose' as const,
  scope: 'short' as const,
  complexity: 'complex' as const,
  confidence: 0.95,
}

function approachResponse(decision: 'patch' | 'regen'): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_approach',
        name: 'classify_compose_approach',
        input: { decision },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 5 },
  }
}

function renderScoreResponse(score: Score): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_render',
        name: 'render_score',
        input: score,
      },
    ],
    usage: { input_tokens: 500, output_tokens: 800 },
  }
}

function editScoreResponse(ops: unknown): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_edit',
        name: 'edit_score',
        input: { ops },
      },
    ],
    usage: { input_tokens: 250, output_tokens: 60 },
  }
}

describe('orchestrator/handlers/compose — sub-classifier dispatch (Lever B)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    _resetComposeClient()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('with the flag OFF and an editedScore present → skips dispatch, runs render_score path', async () => {
    // Flag deliberately unset.
    anthropicCreateMock.mockResolvedValue(renderScoreResponse(VALID_SCORE))
    const result = await runCompose({
      classification: BASE_CLASSIFICATION,
      chatId: 'chat-1',
      userText: 'tweak measure 2',
      editedScore: VALID_SCORE,
    })
    // Exactly ONE LLM call: render_score. No sub-classifier call.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    expect(anthropicCreateMock.mock.calls[0][0].tools[0].name).toBe('render_score')
    expect(result.composePatchDispatch).toBe('skipped')
    expect(result.classification.kind).toBe('compose')
  })

  it('with the flag ON but no editedScore → skips dispatch, runs render_score path', async () => {
    vi.stubEnv('SL_COMPOSE_PATCH_DISPATCH', '1')
    anthropicCreateMock.mockResolvedValue(renderScoreResponse(VALID_SCORE))
    const result = await runCompose({
      classification: BASE_CLASSIFICATION,
      chatId: 'chat-2',
      userText: 'write me a counterpoint piece',
    })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    expect(anthropicCreateMock.mock.calls[0][0].tools[0].name).toBe('render_score')
    expect(result.composePatchDispatch).toBe('skipped')
  })

  it("with the flag ON + editedScore + sub-classifier returns 'patch' → routes to editIntraMeasure (no render_score call)", async () => {
    vi.stubEnv('SL_COMPOSE_PATCH_DISPATCH', '1')
    anthropicCreateMock
      // Call 1: sub-classifier → patch
      .mockResolvedValueOnce(approachResponse('patch'))
      // Call 2: editIntraMeasure → emits ops
      .mockResolvedValueOnce(
        editScoreResponse([
          { kind: 'changePitch', target: { measureIdx: 0, eventIdx: 0 }, deltaStep: 1 },
        ]),
      )
    const result = await runCompose({
      classification: BASE_CLASSIFICATION,
      chatId: 'chat-3',
      userText: 'raise the first note one step',
      editedScore: VALID_SCORE,
    })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
    // Second call should be the edit_score tool, not render_score.
    expect(anthropicCreateMock.mock.calls[1][0].tools[0].name).toBe('edit_score')
    expect(result.composePatchDispatch).toBe('patch')
    // The result must carry the edit_intra_measure kind so summarizeAction
    // routes through the edit summary, not the compose-regen summary.
    expect(result.classification.kind).toBe('edit_intra_measure')
    expect(result.appliedOps).toHaveLength(1)
  })

  it("with the flag ON + editedScore + sub-classifier returns 'regen' → runs the existing render_score path", async () => {
    vi.stubEnv('SL_COMPOSE_PATCH_DISPATCH', '1')
    anthropicCreateMock
      .mockResolvedValueOnce(approachResponse('regen'))
      .mockResolvedValueOnce(renderScoreResponse(VALID_SCORE))
    const result = await runCompose({
      classification: BASE_CLASSIFICATION,
      chatId: 'chat-4',
      userText: 'add a counterpoint as a new voice',
      editedScore: VALID_SCORE,
    })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
    expect(anthropicCreateMock.mock.calls[1][0].tools[0].name).toBe('render_score')
    expect(result.composePatchDispatch).toBe('regen')
    expect(result.classification.kind).toBe('compose')
  })

  it('sub-classifier failure falls back to regen with no behavior regression', async () => {
    vi.stubEnv('SL_COMPOSE_PATCH_DISPATCH', '1')
    anthropicCreateMock
      .mockRejectedValueOnce(new Error('haiku provider down'))
      .mockResolvedValueOnce(renderScoreResponse(VALID_SCORE))
    const result = await runCompose({
      classification: BASE_CLASSIFICATION,
      chatId: 'chat-5',
      userText: 'something',
      editedScore: VALID_SCORE,
    })
    // Two attempts: sub-classifier (failed) + render_score (succeeded).
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
    expect(anthropicCreateMock.mock.calls[1][0].tools[0].name).toBe('render_score')
    expect(result.composePatchDispatch).toBe('regen')
  })

  it('propagates EditIntraMeasureError when the patch path fails (no silent fall-through to render_score)', async () => {
    vi.stubEnv('SL_COMPOSE_PATCH_DISPATCH', '1')
    anthropicCreateMock
      .mockResolvedValueOnce(approachResponse('patch'))
      // editIntraMeasure receives an empty-ops response → throws
      .mockResolvedValueOnce(editScoreResponse([]))
    await expect(
      runCompose({
        classification: BASE_CLASSIFICATION,
        chatId: 'chat-6',
        userText: 'edit something',
        editedScore: VALID_SCORE,
      }),
    ).rejects.toThrow(/edit_intra_measure/)
    // The render_score path must NOT be reached: only 2 calls (approach + edit attempt).
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
    expect(anthropicCreateMock.mock.calls[1][0].tools[0].name).toBe('edit_score')
  })

  it('flag set to a non-truthy value leaves dispatch disabled', async () => {
    vi.stubEnv('SL_COMPOSE_PATCH_DISPATCH', '0')
    anthropicCreateMock.mockResolvedValue(renderScoreResponse(VALID_SCORE))
    const result = await runCompose({
      classification: BASE_CLASSIFICATION,
      chatId: 'chat-7',
      userText: 'tweak measure 2',
      editedScore: VALID_SCORE,
    })
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    expect(result.composePatchDispatch).toBe('skipped')
  })
})
