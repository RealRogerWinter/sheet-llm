import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

// PR-13 — SL_BOUNDED_GEN=0 is the emergency off-switch for the free-tier bounded
// handler; it reverts free users to the legacy path WITHOUT opening the paywall.
// The risk it must NOT create: the sectional pump is multi-call + uncapped (up to
// MAX_TOTAL_BARS=512), so if a free fresh gen could reach it the off-switch would
// hand free users an unbounded, cost-DoS generation. The clamp gates the sectional
// stream on the tier's `allowSectional`, so a free fresh gen falls to the
// single-shot (token-capped) runGenerateComplex instead. Pro is unaffected.
// Mirrors advancedComposerRouting.test.ts: mock both handlers + classify, assert routing.

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
  model: 'claude-sonnet-4-6',
  latencyMs: 5,
  toolUseId: 'toolu_c',
}

const scoreStream = () => ({
  outcomeKind: 'score_stream' as const,
  classification: GEN_COMPLEX_CLASS,
  model: 'claude-sonnet-4-6',
  events: (async function* () {})(),
  chatId: 'c',
  latencyMs: 1,
})

const input = (tier: 'free' | 'pro') => ({
  requestId: 'r',
  chatId: 'c',
  userText: 'compose an enormous original symphony',
  editedScore: undefined,
  history: [],
  generationTier: tier,
})

describe('PR-13 — SL_BOUNDED_GEN=0 must not open the unbounded sectional path for free', () => {
  beforeEach(() => {
    runGenerateSectionalStreamMock.mockReset().mockImplementation(scoreStream)
    runGenerateComplexMock.mockReset().mockResolvedValue(COMPLEX_RESULT)
    classifyMock.mockReset().mockResolvedValue(GEN_COMPLEX_CLASS)
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('SL_SECTIONAL_GEN', '1') // sectional on (default)
    vi.stubEnv('SL_BOUNDED_GEN', '0') // bounded handler OFF → free falls through to classify/dispatch
  })

  it('a FREE fresh generation falls to single-shot generateComplex, NOT the unbounded sectional loop', async () => {
    await run(input('free'))
    expect(runGenerateSectionalStreamMock).not.toHaveBeenCalled()
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
  })

  it('a PRO generation still uses the sectional stream (the clamp is tier-scoped)', async () => {
    await run(input('pro'))
    expect(runGenerateSectionalStreamMock).toHaveBeenCalledTimes(1)
    expect(runGenerateComplexMock).not.toHaveBeenCalled()
  })
})
