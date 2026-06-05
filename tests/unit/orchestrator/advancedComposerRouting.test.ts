import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

// PR-8 — an Advanced (Opus) from-scratch generation BYPASSES the sectional
// stream (which is deliberately Sonnet-tuned) and takes a single Opus pass via
// runGenerateComplex. A Standard pro generation keeps the sectional stream.
// Mock both generation handlers + the classifier and assert which one routes.

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

const GEN_COMPLEX_CLASS = {
  kind: 'generate_complex',
  scope: 'long',
  complexity: 'complex',
  confidence: 0.95,
}

const COMPLEX_RESULT = {
  score: SCORE,
  classification: GEN_COMPLEX_CLASS,
  model: 'claude-opus-4-7',
  latencyMs: 5,
  toolUseId: 'toolu_c',
}

// Minimal OrchestratorScoreStream (the route would own the events; the test
// never consumes them).
const scoreStream = () => ({
  outcomeKind: 'score_stream' as const,
  classification: GEN_COMPLEX_CLASS,
  model: 'claude-sonnet-4-6',
  // eslint-disable-next-line require-yield
  events: (async function* () {})(),
  chatId: 'c',
  latencyMs: 1,
})

const baseInput = (advancedComposer?: boolean) => ({
  requestId: 'r',
  chatId: 'c',
  userText: 'compose a short original waltz',
  editedScore: undefined,
  history: [],
  generationTier: 'pro' as const,
  ...(advancedComposer !== undefined ? { advancedComposer } : {}),
})

describe('PR-8 — Advanced Composer bypasses the sectional stream', () => {
  beforeEach(() => {
    runGenerateSectionalStreamMock.mockReset().mockImplementation(scoreStream)
    runGenerateComplexMock.mockReset().mockResolvedValue(COMPLEX_RESULT)
    classifyMock.mockReset().mockResolvedValue(GEN_COMPLEX_CLASS)
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('SL_SECTIONAL_GEN', '1') // on by default; explicit for clarity
  })

  it('a Standard pro generation routes to the sectional STREAM (Sonnet)', async () => {
    await run(baseInput(false))
    expect(runGenerateSectionalStreamMock).toHaveBeenCalledTimes(1)
    expect(runGenerateComplexMock).not.toHaveBeenCalled()
  })

  it('an Advanced pro generation BYPASSES sectional → single-shot generateComplex', async () => {
    await run(baseInput(true))
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
    expect(runGenerateSectionalStreamMock).not.toHaveBeenCalled()
    // The Advanced flag is threaded into the handler so it routes to Opus.
    expect(runGenerateComplexMock.mock.calls[0][0].advancedComposer).toBe(true)
  })

  it('with sectional DISABLED both tiers use single-shot; only Advanced sets the Opus flag', async () => {
    vi.stubEnv('SL_SECTIONAL_GEN', '0')
    await run(baseInput(false))
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
    expect(runGenerateComplexMock.mock.calls[0][0].advancedComposer).toBeFalsy()
    expect(runGenerateSectionalStreamMock).not.toHaveBeenCalled()
  })
})
