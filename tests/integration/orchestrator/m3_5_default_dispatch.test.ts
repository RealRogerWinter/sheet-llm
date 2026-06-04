import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'

/**
 * M3.5-PR-6 — migration test: verifies that the native tool-use
 * dispatcher is the DEFAULT routing path post-flag-flip, and that
 * SL_NEW_TOOL_DISPATCH=0 / =false still falls back to the legacy
 * classifier path.
 *
 * Mocks both the dispatcher (toolDispatch.run) and the legacy
 * classifier (classify). The legacy path's classifier is NOT consulted
 * when the dispatcher fires; the dispatcher is NOT consulted when the
 * flag opts out. Asserting which mock is called pins the routing
 * decision.
 */

const BASE_SCORE: Score = {
  title: 'Triplet demo',
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

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) {
      super(m)
      this.name = 'ClassifierSchemaError'
    }
  },
}))

const toolDispatchMock = vi.fn()
vi.mock('@/lib/orchestrator/toolDispatch', () => ({
  run: toolDispatchMock,
  ToolDispatchError: class extends Error {},
}))

const runExtendCompositionMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/extendComposition', () => ({
  runExtendComposition: runExtendCompositionMock,
  ExtendCompositionError: class extends Error {},
}))

const runComposeMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/compose', () => ({
  runCompose: runComposeMock,
  _resetComposeClient: () => undefined,
}))

const runConverseMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/converse', () => ({
  runConverse: runConverseMock,
}))

const { run } = await import('@/lib/orchestrator')

const EXTENDED_SCORE: Score = {
  ...BASE_SCORE,
  measures: [
    ...BASE_SCORE.measures,
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
  ],
}

function stubExtendDispatch(): void {
  toolDispatchMock.mockResolvedValue({
    tool: 'extend_composition',
    args: { targetBars: 4, hint: 'i iv v turnaround' },
    confidence: 0.9,
    model: 'claude-haiku-4-5',
  })
  runExtendCompositionMock.mockResolvedValue({
    score: EXTENDED_SCORE,
    classification: {
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    },
    model: 'claude-sonnet-4-6',
    latencyMs: 50,
    dispatchTool: 'extend_composition',
  })
}

function stubLegacyClassifier(): void {
  classifyMock.mockResolvedValue({
    kind: 'compose',
    scope: 'short',
    complexity: 'complex',
    confidence: 0.9,
  })
  runComposeMock.mockResolvedValue({
    score: EXTENDED_SCORE,
    classification: {
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    },
    model: 'claude-sonnet-4-6',
    latencyMs: 50,
    toolUseId: 'toolu_legacy_1',
  })
}

describe('M3.5-PR-6 — SL_NEW_TOOL_DISPATCH default-on routing', () => {
  beforeEach(() => {
    classifyMock.mockReset()
    toolDispatchMock.mockReset()
    runExtendCompositionMock.mockReset()
    runComposeMock.mockReset()
    runConverseMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('default env (unset SL_NEW_TOOL_DISPATCH) → new dispatch path fires for "add 4 more bars"', async () => {
    stubExtendDispatch()
    // Also stub the legacy mocks so a mis-route would surface but not crash.
    stubLegacyClassifier()

    const result = await run({
      requestId: 'r-default',
      userText: 'add 4 more bars with a i iv v turnaround',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    expect(toolDispatchMock).toHaveBeenCalledTimes(1)
    expect(runExtendCompositionMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).not.toHaveBeenCalled()
    if (
      result &&
      !('refused' in result) &&
      !('fellThrough' in result) &&
      !('outcomeKind' in result)
    ) {
      expect(result.dispatchTool).toBe('extend_composition')
    }
  })

  it('default env → a music-theory QUESTION routes through the dispatcher to runConverse', async () => {
    // Regression: before answer_question existed, the dispatcher (tool_choice
    // 'required' over 5 edit-only tools) was forced to pick edit_intra_measure
    // for a question, which then threw "model emitted no ops" and fell through
    // to the legacy score path — so the user got no answer.
    toolDispatchMock.mockResolvedValue({
      tool: 'answer_question',
      args: { question: 'explain what the bass line is doing harmonically' },
      confidence: 0.85,
      model: 'claude-sonnet-4-6',
    })
    async function* noEvents(): AsyncGenerator<never> {
      // Empty stream — the route, not run(), consumes events; we only
      // assert the handler was invoked and the outcome is a converse stream.
    }
    runConverseMock.mockReturnValue({
      outcomeKind: 'converse_stream',
      classification: {
        kind: 'converse',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.85,
      },
      model: 'claude-sonnet-4-6',
      events: noEvents(),
      chatId: 'c-converse',
      latencyMs: 5,
    })

    const result = await run({
      requestId: 'r-converse',
      chatId: 'c-converse',
      userText: 'explain the bass line to me in terms of music theory. what is happening?',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(toolDispatchMock).toHaveBeenCalledTimes(1)
    expect(runConverseMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).not.toHaveBeenCalled()
    expect(result && 'outcomeKind' in result && result.outcomeKind).toBe('converse_stream')
    // The converse handler got the score + the verbatim original prompt.
    const converseArg = runConverseMock.mock.calls[0][0]
    expect(converseArg.editedScore).toEqual(BASE_SCORE)
    expect(converseArg.userText).toContain('explain the bass line')
    expect(converseArg.classification.kind).toBe('converse')
  })

  it('SL_NEW_TOOL_DISPATCH=0 → legacy classifier path fires (no dispatchTool on result)', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    stubExtendDispatch()
    stubLegacyClassifier()

    const result = await run({
      requestId: 'r-opt-out-0',
      userText: 'add 4 more bars with a i iv v turnaround',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    expect(toolDispatchMock).not.toHaveBeenCalled()
    expect(runExtendCompositionMock).not.toHaveBeenCalled()
    expect(classifyMock).toHaveBeenCalledTimes(1)
    expect(runComposeMock).toHaveBeenCalledTimes(1)
    if (
      result &&
      !('refused' in result) &&
      !('fellThrough' in result) &&
      !('outcomeKind' in result)
    ) {
      expect(result.dispatchTool).toBeUndefined()
    }
  })

  it('SL_NEW_TOOL_DISPATCH=false → legacy classifier path fires', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', 'false')
    stubExtendDispatch()
    stubLegacyClassifier()

    const result = await run({
      requestId: 'r-opt-out-false',
      userText: 'add 4 more bars with a i iv v turnaround',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    expect(toolDispatchMock).not.toHaveBeenCalled()
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('SL_NEW_TOOL_DISPATCH=1 → new dispatch path fires (explicit on)', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '1')
    stubExtendDispatch()
    stubLegacyClassifier()

    const result = await run({
      requestId: 'r-explicit-on',
      userText: 'add 4 more bars',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    expect(toolDispatchMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it('SL_NEW_TOOL_DISPATCH=true → new dispatch path fires', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', 'true')
    stubExtendDispatch()
    stubLegacyClassifier()

    const result = await run({
      requestId: 'r-explicit-true',
      userText: 'add 4 more bars',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    expect(toolDispatchMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).not.toHaveBeenCalled()
  })
})

describe('M26 — free-tier scope gate (runDispatchedHandler)', () => {
  beforeEach(() => {
    classifyMock.mockReset()
    toolDispatchMock.mockReset()
    runExtendCompositionMock.mockReset()
    runComposeMock.mockReset()
    runConverseMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  afterEach(() => vi.unstubAllEnvs())

  function stubRegenerateAll(): void {
    toolDispatchMock.mockResolvedValue({
      tool: 'regenerate_all',
      args: { confirmExplicitRewrite: true, justification: 'user asked to start over' },
      confidence: 0.95,
      model: 'claude-sonnet-4-6',
    })
    runComposeMock.mockResolvedValue({
      score: EXTENDED_SCORE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.95 },
      model: 'claude-sonnet-4-6',
      latencyMs: 50,
      toolUseId: 'toolu_regen',
    })
  }

  function stubExtend16(): void {
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 16, hint: 'long outro' },
      confidence: 0.9,
      model: 'claude-sonnet-4-6',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: EXTENDED_SCORE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.9 },
      model: 'claude-sonnet-4-6',
      latencyMs: 50,
      dispatchTool: 'extend_composition',
    })
  }

  it('free tier refuses regenerate_all (whole-score rewrite is pro-only)', async () => {
    stubRegenerateAll()
    const result = await run({
      requestId: 'r-free-regen',
      chatId: 'c-free-regen',
      userText: 'rewrite the whole thing from scratch',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'free',
    })
    expect(result && 'refused' in result).toBe(true)
    if (result && 'refused' in result) {
      expect(result.refusalCode).toBe('pro_only')
      expect(result.reason).toMatch(/pro/i)
    }
    // Refused BEFORE the expensive whole-score handler ran.
    expect(runComposeMock).not.toHaveBeenCalled()
  })

  it('pro tier runs regenerate_all (runCompose) — not refused', async () => {
    stubRegenerateAll()
    const result = await run({
      requestId: 'r-pro-regen',
      chatId: 'c-pro-regen',
      userText: 'rewrite the whole thing from scratch',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'pro',
    })
    expect(result && 'refused' in result).toBe(false)
    expect(runComposeMock).toHaveBeenCalledTimes(1)
  })

  it('free tier clamps extend_composition to 4 bars and warns', async () => {
    stubExtend16()
    const result = await run({
      requestId: 'r-free-extend',
      chatId: 'c-free-extend',
      userText: 'add 16 bars of outro',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'free',
    })
    // Clamped down to the free policy's maxBars (4).
    expect(runExtendCompositionMock.mock.calls[0][0].targetBars).toBe(4)
    const warnings = (result as { warnings?: string[] }).warnings ?? []
    expect(warnings.some((w) => /Free tier adds up to 4 bars/.test(w))).toBe(true)
  })

  it('pro tier passes extend_composition targetBars through unclamped', async () => {
    stubExtend16()
    await run({
      requestId: 'r-pro-extend',
      chatId: 'c-pro-extend',
      userText: 'add 16 bars of outro',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'pro',
    })
    expect(runExtendCompositionMock.mock.calls[0][0].targetBars).toBe(16)
  })
})
