import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

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
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

/** Wholesale replacement output: different bars + key + meter + title. */
const REPLACEMENT_SCORE: Score = {
  title: '5/4 ostinato',
  key: 'Am',
  meter: '5/4',
  measures: Array.from({ length: 4 }, () => ({
    events: [
      { pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ],
  })),
}

/** Same key/meter/title, with 2 bars retained + 2 new bars at the end. */
const EXTEND_SCORE: Score = {
  ...BASE_SCORE,
  measures: [
    ...BASE_SCORE.measures,
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
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

const runComposeMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/compose', () => ({
  runCompose: runComposeMock,
  _resetComposeClient: () => undefined,
}))

const runExtendCompositionMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/extendComposition', () => ({
  runExtendComposition: runExtendCompositionMock,
  ExtendCompositionError: class extends Error {},
}))

const toolDispatchMock = vi.fn()
vi.mock('@/lib/orchestrator/toolDispatch', () => ({
  run: toolDispatchMock,
  ToolDispatchError: class extends Error {},
}))

const { run } = await import('@/lib/orchestrator')

describe('orchestrator replacement-confirmation gate (M3.5-PR-4)', () => {
  beforeEach(() => {
    classifyMock.mockReset()
    runComposeMock.mockReset()
    runExtendCompositionMock.mockReset()
    toolDispatchMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // Default: legacy classifier path. Specific tests below opt INTO
    // the new dispatcher path via `SL_NEW_TOOL_DISPATCH=1` as needed.
    // (PR-6 flipped the global default; tests that explicitly exercise
    // the legacy path force it off here.)
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    // M24-PR-6 flipped SL_GHOST_PREVIEW default ON. These tests
    // specifically exercise the M3.5 replacement gate's "does it fire
    // or not?" boolean; the ghost-preview hook would otherwise attach
    // a proposal to every non-replacement-gated turn (also setting
    // requiresConfirmation=true) and break the
    // `requiresConfirmation === undefined` assertions below. Opt out
    // for the duration of the suite so only the gate's signal is tested.
    vi.stubEnv('SL_GHOST_PREVIEW', '0')
  })

  it('flags requiresConfirmation on synthetic wholesale replacement (legacy path)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: REPLACEMENT_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
      toolUseId: 'toolu_llm_1',
    })

    const result = await run({
      requestId: 'r-replace',
      userText: 'make it more jazzy',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBe(true)
    expect(result.replacement).toBeDefined()
    expect(result.replacement?.retainedIdentityRatio ?? 1).toBeLessThan(0.5)
    expect(result.replacement?.reasons.some((r) => r.includes('key C → Am'))).toBe(true)
  })

  it('does NOT flag extend_composition output (key/meter/title intact)', async () => {
    // Run through the new dispatch path: tool=extend_composition,
    // handler returns the EXTEND_SCORE (2 retained + 2 new bars).
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '1')
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 2 },
      confidence: 0.9,
      model: 'claude-haiku-4-5',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: EXTEND_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
      dispatchTool: 'extend_composition',
    })

    const result = await run({
      requestId: 'r-extend',
      userText: 'add 2 more bars',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBeUndefined()
    expect(result.replacement).toBeUndefined()
  })

  it('bypasses the gate when SL_REPLACEMENT_GATE=0', async () => {
    vi.stubEnv('SL_REPLACEMENT_GATE', '0')
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: REPLACEMENT_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
      toolUseId: 'toolu_llm_1',
    })

    const result = await run({
      requestId: 'r-bypass',
      userText: 'make it more jazzy',
      editedScore: BASE_SCORE,
      history: [],
    })

    expect(result).toBeTruthy()
    if (!result || 'refused' in result || 'fellThrough' in result || 'outcomeKind' in result) {
      throw new Error('expected OrchestratorResult')
    }
    expect(result.requiresConfirmation).toBeUndefined()
    expect(result.replacement).toBeUndefined()
  })
})
