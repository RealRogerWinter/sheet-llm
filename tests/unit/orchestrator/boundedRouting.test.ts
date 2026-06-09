import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { toTierPolicy } from '@/lib/orchestrator/generationTier'

const runGenerateBoundedMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/generateBounded', () => ({
  runGenerateBounded: runGenerateBoundedMock,
  GenerateBoundedError: class extends Error {},
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

// A no-LLM classifier result so the negative-routing cases (where the choke
// point is skipped) resolve cheaply through runRefuse instead of a real call.
const REFUSE = { kind: 'refuse', scope: 'snippet', complexity: 'simple', confidence: 0.99, reason: 'test' }

describe('M26 — bounded-generation choke point routing', () => {
  beforeEach(() => {
    runGenerateBoundedMock.mockReset()
    runGenerateBoundedMock.mockResolvedValue(BOUNDED_RESULT)
    classifyMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  it('free tier + fresh generation routes to runGenerateBounded and NEVER classifies', async () => {
    const result = await run({
      requestId: 'r1',
      chatId: 'c1',
      userText: 'write me a 16-bar sonata',
      editedScore: undefined,
      history: [],
      tierPolicy: toTierPolicy('free'),
    })
    expect(runGenerateBoundedMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).not.toHaveBeenCalled()
    expect(result && !('refused' in result) && !('fellThrough' in result) && 'score' in result).toBe(true)
    // The free policy ceiling is threaded into the handler.
    expect(runGenerateBoundedMock.mock.calls[0][0].maxOutputTokens).toBe(2600)
  })

  it('no injected tierPolicy → uncapped OSS default: the choke point is skipped (route.ts injects the fail-closed policy)', async () => {
    classifyMock.mockResolvedValue(REFUSE)
    await run({ requestId: 'r2', chatId: 'c2', userText: 'a scale', editedScore: undefined, history: [] })
    expect(runGenerateBoundedMock).not.toHaveBeenCalled()
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('a vague prompt (would be <0.6 confidence) is still capped for free — the confidence-floor escape is closed', async () => {
    await run({
      requestId: 'r3',
      chatId: 'c3',
      userText: 'make it jazzier somehow',
      editedScore: undefined,
      history: [],
      tierPolicy: toTierPolicy('free'),
    })
    expect(runGenerateBoundedMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it('pro tier skips the choke point and goes to classify/dispatch', async () => {
    classifyMock.mockResolvedValue(REFUSE)
    await run({
      requestId: 'r4',
      chatId: 'c4',
      userText: 'a scale',
      editedScore: undefined,
      history: [{ role: 'user', content: [{ type: 'text', text: 'a scale' }] }],
      tierPolicy: toTierPolicy('pro'),
    })
    expect(runGenerateBoundedMock).not.toHaveBeenCalled()
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('SL_BOUNDED_GEN=0 reverts free users to the legacy path (no bounded call)', async () => {
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    classifyMock.mockResolvedValue(REFUSE)
    await run({
      requestId: 'r5',
      chatId: 'c5',
      userText: 'a scale',
      editedScore: undefined,
      history: [{ role: 'user', content: [{ type: 'text', text: 'a scale' }] }],
      tierPolicy: toTierPolicy('free'),
    })
    expect(runGenerateBoundedMock).not.toHaveBeenCalled()
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('an edit (editedScore present) skips the choke point', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0') // force the classifier path so no real dispatch LLM call
    classifyMock.mockResolvedValue(REFUSE)
    await run({
      requestId: 'r6',
      chatId: 'c6',
      userText: 'raise the third note',
      editedScore: SCORE,
      history: [],
      tierPolicy: toTierPolicy('free'),
    })
    expect(runGenerateBoundedMock).not.toHaveBeenCalled()
  })
})
