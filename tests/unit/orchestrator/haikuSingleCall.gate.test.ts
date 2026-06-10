import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { OrchestratorResult } from '@/lib/orchestrator/types'

/**
 * SHE-19 PR2 — gate + fallback for the FREE-TIER single-call collapse.
 *
 * The orchestrator's edit branch routes through `runHaikuSingleCall` (ONE
 * Haiku `tool_choice:'auto'` call) ONLY when ALL of:
 *   - `input.editedScore` is present, AND
 *   - `getGenerationTier() === 'free'`, AND
 *   - `isHaikuSingleCallEnabled()` (`SL_HAIKU_SINGLE_CALL` truthy).
 * Otherwise the legacy 2-call native dispatch path (`toolDispatchRun` →
 * `runDispatchedHandler`) runs. And if the unified call THROWS, the
 * orchestrator must fall back to the 2-call path rather than dropping the turn.
 *
 * We mock BOTH `haikuSingleCall` and `toolDispatch` so we can observe which
 * path ran. The downstream handlers the 2-call path calls are mocked to a
 * trivial success so a fallback run still returns a valid result.
 */

const BASE_SCORE: Score = {
  title: 'Base',
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

// ── The unified single call ──────────────────────────────────────────────────
const runHaikuSingleCallMock = vi.fn()
vi.mock('@/lib/orchestrator/haikuSingleCall', () => ({
  runHaikuSingleCall: runHaikuSingleCallMock,
  HaikuSingleCallError: class extends Error {
    constructor(m: string) {
      super(m)
      this.name = 'HaikuSingleCallError'
    }
  },
}))

// ── The 2-call native dispatcher (the fallback / non-unified path) ───────────
const toolDispatchRunMock = vi.fn()
vi.mock('@/lib/orchestrator/toolDispatch', () => ({
  run: toolDispatchRunMock,
  ToolDispatchError: class extends Error {
    constructor(m: string) {
      super(m)
      this.name = 'ToolDispatchError'
    }
  },
}))

// The 2-call path's edit_intra_measure handler — return a trivial result so a
// fallback run produces a valid OrchestratorResult.
const runEditIntraMeasureMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/editIntraMeasure', () => ({
  runEditIntraMeasure: runEditIntraMeasureMock,
  EditIntraMeasureError: class extends Error {
    constructor(m: string) {
      super(m)
      this.name = 'EditIntraMeasureError'
    }
  },
}))

const { run } = await import('@/lib/orchestrator')

function unifiedResult(): OrchestratorResult {
  return {
    score: { ...BASE_SCORE, title: 'After unified single call' },
    classification: { kind: 'edit_intra_measure', scope: 'short', complexity: 'complex', confidence: 0.85 },
    model: 'claude-haiku-4-5',
    latencyMs: 3,
    appliedOps: [],
    dispatchTool: 'edit_intra_measure',
    toolUseId: 'toolu_unified',
  }
}

function dispatchDecision() {
  return {
    tool: 'edit_intra_measure' as const,
    args: { targetDescription: 'raise the third note' },
    confidence: 0.85,
    model: 'claude-haiku-4-5',
    toolUseId: 'toolu_dispatch',
  }
}

function intraHandlerResult(): OrchestratorResult {
  return {
    score: { ...BASE_SCORE, title: 'After 2-call dispatch' },
    classification: { kind: 'edit_intra_measure', scope: 'short', complexity: 'complex', confidence: 0.85 },
    model: 'claude-haiku-4-5',
    latencyMs: 4,
    appliedOps: [],
    toolUseId: 'toolu_handler',
  }
}

function isResult(o: unknown): o is OrchestratorResult {
  return !!o && typeof o === 'object' && 'score' in o && !('refused' in o) && !('fellThrough' in o)
}

describe('orchestrator — SHE-19 PR2 single-call gate + fallback', () => {
  beforeEach(() => {
    runHaikuSingleCallMock.mockReset()
    toolDispatchRunMock.mockReset()
    runEditIntraMeasureMock.mockReset()
    runEditIntraMeasureMock.mockResolvedValue(intraHandlerResult())
    toolDispatchRunMock.mockResolvedValue(dispatchDecision())
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // Keep the replacement gate + ghost preview off so we assert on path
    // selection cleanly (they don't affect which path runs).
    vi.stubEnv('SL_REPLACEMENT_GATE', '0')
    vi.stubEnv('SL_GHOST_PREVIEW', '0')
  })

  it('free tier + flag ON → unified path taken; 2-call dispatch NOT called', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
    runHaikuSingleCallMock.mockResolvedValue(unifiedResult())

    const result = await run({
      requestId: 'r-unified',
      chatId: 'chat-unified',
      userText: 'raise the third note',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'free',
    })

    expect(runHaikuSingleCallMock).toHaveBeenCalledTimes(1)
    expect(toolDispatchRunMock).not.toHaveBeenCalled()
    expect(isResult(result)).toBe(true)
    if (isResult(result)) expect(result.score.title).toBe('After unified single call')
  })

  it('pro tier + flag ON → 2-call dispatch path; unified NOT called', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')

    const result = await run({
      requestId: 'r-pro',
      chatId: 'chat-pro',
      userText: 'raise the third note',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'pro',
    })

    expect(runHaikuSingleCallMock).not.toHaveBeenCalled()
    expect(toolDispatchRunMock).toHaveBeenCalledTimes(1)
    expect(runEditIntraMeasureMock).toHaveBeenCalledTimes(1)
    expect(isResult(result)).toBe(true)
    if (isResult(result)) expect(result.score.title).toBe('After 2-call dispatch')
  })

  it('free tier + flag OFF → 2-call dispatch path; unified NOT called', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    // SL_HAIKU_SINGLE_CALL unset → isHaikuSingleCallEnabled() === false.

    const result = await run({
      requestId: 'r-flagoff',
      chatId: 'chat-flagoff',
      userText: 'raise the third note',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'free',
    })

    expect(runHaikuSingleCallMock).not.toHaveBeenCalled()
    expect(toolDispatchRunMock).toHaveBeenCalledTimes(1)
    expect(isResult(result)).toBe(true)
    if (isResult(result)) expect(result.score.title).toBe('After 2-call dispatch')
  })

  it('fallback: flag ON + unified THROWS → falls back to 2-call path, turn not dropped', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
    runHaikuSingleCallMock.mockRejectedValue(new Error('boom: malformed single call'))

    const result = await run({
      requestId: 'r-fallback',
      chatId: 'chat-fallback',
      userText: 'raise the third note',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'free',
    })

    // The unified call was attempted...
    expect(runHaikuSingleCallMock).toHaveBeenCalledTimes(1)
    // ...threw, and the orchestrator fell back to the 2-call dispatch path.
    expect(toolDispatchRunMock).toHaveBeenCalledTimes(1)
    expect(runEditIntraMeasureMock).toHaveBeenCalledTimes(1)
    // The turn is NOT dropped — a valid result comes back.
    expect(isResult(result)).toBe(true)
    if (isResult(result)) expect(result.score.title).toBe('After 2-call dispatch')
  })

  it('fallback: unsupported-provider error from unified → still falls back', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
    const { MultiToolUnsupportedError } = await import('@/lib/providers/types')
    runHaikuSingleCallMock.mockRejectedValue(
      new MultiToolUnsupportedError('Anthropic-only; resolved provider is groq'),
    )

    const result = await run({
      requestId: 'r-unsupported',
      chatId: 'chat-unsupported',
      userText: 'raise the third note',
      editedScore: BASE_SCORE,
      history: [],
      generationTier: 'free',
    })

    expect(runHaikuSingleCallMock).toHaveBeenCalledTimes(1)
    expect(toolDispatchRunMock).toHaveBeenCalledTimes(1)
    expect(isResult(result)).toBe(true)
    if (isResult(result)) expect(result.score.title).toBe('After 2-call dispatch')
  })

  it('no editedScore (fresh generation) → unified NOT taken even on free + flag ON', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'free')
    vi.stubEnv('SL_HAIKU_SINGLE_CALL', '1')
    // A fresh generation on free goes through the bounded-gen choke point, not
    // the single-call collapse. Opt out of bounded gen so the call simply does
    // not reach the unified path; we only assert the unified path is skipped.
    vi.stubEnv('SL_BOUNDED_GEN', '0')

    await run({
      requestId: 'r-fresh',
      chatId: 'chat-fresh',
      userText: 'write a c major scale',
      editedScore: undefined,
      history: [],
      generationTier: 'free',
    }).catch(() => undefined)

    expect(runHaikuSingleCallMock).not.toHaveBeenCalled()
  })
})
