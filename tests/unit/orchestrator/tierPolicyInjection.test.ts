import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'

/**
 * SHE-8 Phase-0 keystone — the orchestrator must read a CALLER-INJECTED
 * `tierPolicy` for every paywall/scope decision instead of importing
 * `policyFor`/`generationTier`. This pins the inversion:
 *
 *  - the bounded-generation choke point reads `useBoundedFallback` +
 *    `emitCeiling` from the injected policy (NOT the imported 2600 constant),
 *  - the fresh-gen sectional fork reads `allowSectional`,
 *  - the dispatch handler reads `allowWholeScore` (regenerate_all gate) and
 *    `maxBars` (extend/insert clamp).
 *
 * Crucially, with NO `tierPolicy` injected the core is UNCAPPED (OSS-safe:
 * an absent policy means "no restrictions"). The hosted paywall is enforced
 * by route.ts injecting a capped policy, never by a kernel default.
 *
 * Mocks the handlers + dispatcher and asserts which one ran with what args,
 * mirroring boundedRouting / boundedGenClamp / m3_5_default_dispatch.
 */

const runGenerateBoundedMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/generateBounded', () => ({
  runGenerateBounded: runGenerateBoundedMock,
  GenerateBoundedError: class extends Error {},
}))

const runGenerateSectionalStreamMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/generateSectional', async (orig) => ({
  ...(await orig<typeof import('@/lib/orchestrator/handlers/generateSectional')>()),
  runGenerateSectionalStream: runGenerateSectionalStreamMock,
}))

const runGenerateComplexMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/generateComplex', async (orig) => ({
  ...(await orig<typeof import('@/lib/orchestrator/handlers/generateComplex')>()),
  runGenerateComplex: runGenerateComplexMock,
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

const { run } = await import('@/lib/orchestrator')

const SCORE: Score = {
  title: 't',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
}

const BOUNDED_RESULT = {
  score: SCORE,
  classification: { kind: 'generate_complex', scope: 'short', complexity: 'simple', confidence: 1 },
  model: 'claude-sonnet-4-6',
  latencyMs: 5,
  toolUseId: 'toolu_b',
}

const GEN_COMPLEX_CLASS = {
  kind: 'generate_complex',
  scope: 'long',
  complexity: 'complex',
  confidence: 0.95,
}
const COMPLEX_RESULT = {
  score: SCORE,
  classification: GEN_COMPLEX_CLASS,
  model: 'claude-sonnet-4-6',
  latencyMs: 5,
  toolUseId: 'toolu_c',
}
const REFUSE = { kind: 'refuse', scope: 'snippet', complexity: 'simple', confidence: 0.99, reason: 'test' }
const scoreStream = () => ({
  outcomeKind: 'score_stream' as const,
  classification: GEN_COMPLEX_CLASS,
  model: 'claude-sonnet-4-6',
  events: (async function* () {})(),
  chatId: 'c',
  latencyMs: 1,
})

// A capped (free-shaped) policy with a DISTINCTIVE emitCeiling so we can prove
// the orchestrator reads the injected value, not the imported 2600 constant.
const CAPPED_FREE = {
  allowSectional: false,
  allowWholeScore: false,
  maxBars: 4,
  emitCeiling: 1234,
  useBoundedFallback: true,
}
// The OSS / uncapped policy: never bounded, never paywalled.
const UNCAPPED = {
  allowSectional: true,
  allowWholeScore: true,
  maxBars: 64,
  emitCeiling: 8000,
  useBoundedFallback: false,
}

describe('SHE-8 — orchestrator reads an injected TierPolicy (not policyFor/generationTier)', () => {
  beforeEach(() => {
    runGenerateBoundedMock.mockReset().mockResolvedValue(BOUNDED_RESULT)
    runGenerateSectionalStreamMock.mockReset().mockImplementation(scoreStream)
    runGenerateComplexMock.mockReset().mockResolvedValue(COMPLEX_RESULT)
    runComposeMock.mockReset().mockResolvedValue({
      ...COMPLEX_RESULT,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.95 },
    })
    runExtendCompositionMock.mockReset()
    toolDispatchMock.mockReset()
    classifyMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('SL_SECTIONAL_GEN', '1')
    vi.stubEnv('SL_BOUNDED_GEN', '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('no tierPolicy injected → uncapped default: a fresh prompt is NOT routed to the bounded handler', async () => {
    // generationTier:'free' is supplied to prove it no longer drives policy.
    classifyMock.mockResolvedValue(REFUSE)
    await run({
      requestId: 'r-oss',
      chatId: 'c-oss',
      userText: 'write me a 16-bar sonata',
      editedScore: undefined,
      history: [],
      generationTier: 'free',
    })
    expect(runGenerateBoundedMock).not.toHaveBeenCalled()
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('injected capped policy routes a fresh gen to the bounded handler with the INJECTED emitCeiling', async () => {
    await run({
      requestId: 'r-cap',
      chatId: 'c-cap',
      userText: 'write me a 16-bar sonata',
      editedScore: undefined,
      history: [],
      tierPolicy: CAPPED_FREE,
    })
    expect(runGenerateBoundedMock).toHaveBeenCalledTimes(1)
    expect(runGenerateBoundedMock.mock.calls[0][0].maxOutputTokens).toBe(1234)
  })

  it('injected allowSectional:false → single-shot generateComplex (not the unbounded sectional loop)', async () => {
    classifyMock.mockResolvedValue(GEN_COMPLEX_CLASS)
    await run({
      requestId: 'r-nosect',
      chatId: 'c-nosect',
      userText: 'compose a long original piece',
      editedScore: undefined,
      history: [],
      tierPolicy: { ...UNCAPPED, allowSectional: false },
    })
    expect(runGenerateSectionalStreamMock).not.toHaveBeenCalled()
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
  })

  it('injected allowSectional:true → the sectional stream', async () => {
    classifyMock.mockResolvedValue(GEN_COMPLEX_CLASS)
    await run({
      requestId: 'r-sect',
      chatId: 'c-sect',
      userText: 'compose a long original piece',
      editedScore: undefined,
      history: [],
      tierPolicy: UNCAPPED,
    })
    expect(runGenerateSectionalStreamMock).toHaveBeenCalledTimes(1)
    expect(runGenerateComplexMock).not.toHaveBeenCalled()
  })

  it('injected allowWholeScore:false → regenerate_all is refused pro_only', async () => {
    toolDispatchMock.mockResolvedValue({
      tool: 'regenerate_all',
      args: { confirmExplicitRewrite: true, justification: 'start over' },
      confidence: 0.95,
      model: 'claude-sonnet-4-6',
    })
    const result = await run({
      requestId: 'r-regen-free',
      chatId: 'c-regen-free',
      userText: 'rewrite the whole thing from scratch',
      editedScore: SCORE,
      history: [],
      tierPolicy: CAPPED_FREE,
    })
    expect(result && 'refused' in result).toBe(true)
    if (result && 'refused' in result) expect(result.refusalCode).toBe('pro_only')
    expect(runComposeMock).not.toHaveBeenCalled()
  })

  it('injected allowWholeScore:true → regenerate_all runs (runCompose), not refused', async () => {
    toolDispatchMock.mockResolvedValue({
      tool: 'regenerate_all',
      args: { confirmExplicitRewrite: true, justification: 'start over' },
      confidence: 0.95,
      model: 'claude-sonnet-4-6',
    })
    const result = await run({
      requestId: 'r-regen-pro',
      chatId: 'c-regen-pro',
      userText: 'rewrite the whole thing from scratch',
      editedScore: SCORE,
      history: [],
      tierPolicy: UNCAPPED,
    })
    expect(result && 'refused' in result).toBe(false)
    expect(runComposeMock).toHaveBeenCalledTimes(1)
  })

  it('injected maxBars:4 clamps extend_composition to 4 bars and warns', async () => {
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 16, hint: 'long outro' },
      confidence: 0.9,
      model: 'claude-sonnet-4-6',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: SCORE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.9 },
      model: 'claude-sonnet-4-6',
      latencyMs: 50,
      dispatchTool: 'extend_composition',
    })
    const result = await run({
      requestId: 'r-extend-free',
      chatId: 'c-extend-free',
      userText: 'add 16 bars of outro',
      editedScore: SCORE,
      history: [],
      tierPolicy: CAPPED_FREE,
    })
    expect(runExtendCompositionMock.mock.calls[0][0].targetBars).toBe(4)
    const warnings = (result as { warnings?: string[] }).warnings ?? []
    expect(warnings.some((w) => /up to 4 bars/.test(w))).toBe(true)
  })

  it('injected maxBars:64 leaves extend_composition unclamped', async () => {
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 16, hint: 'long outro' },
      confidence: 0.9,
      model: 'claude-sonnet-4-6',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: SCORE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.9 },
      model: 'claude-sonnet-4-6',
      latencyMs: 50,
      dispatchTool: 'extend_composition',
    })
    await run({
      requestId: 'r-extend-pro',
      chatId: 'c-extend-pro',
      userText: 'add 16 bars of outro',
      editedScore: SCORE,
      history: [],
      tierPolicy: UNCAPPED,
    })
    expect(runExtendCompositionMock.mock.calls[0][0].targetBars).toBe(16)
  })
})
