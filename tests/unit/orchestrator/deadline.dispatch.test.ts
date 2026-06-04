import { describe, it, expect, vi, beforeEach } from 'vitest'

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) { super(m); this.name = 'ClassifierSchemaError' }
  },
}))

const { run } = await import('@/lib/orchestrator')

describe('orchestrator.run — deadline awareness', () => {
  beforeEach(() => {
    classifyMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // M26: these deadline tests drive fresh generation through the legacy
    // classifier path; opt out of the bounded free-tier choke point.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
  })

  it('returns deadline_exceeded fall-through when deadlineAt is in the past', async () => {
    const result = await run({
      requestId: 'r-d1',
      userText: 'hi',
      editedScore: undefined,
      history: [],
      deadlineAt: Date.now() - 1_000,
    })
    expect(result).not.toBeNull()
    if (result && 'fellThrough' in result) {
      expect(result.reason).toBe('deadline_exceeded')
    } else {
      throw new Error('expected fall-through')
    }
    // Classifier was NOT called — we bailed before any LLM expense.
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it('returns deadline_exceeded when less than the classifier estimate remains', async () => {
    // Default classifier estimate is ~2000ms; deadline 500ms away → bail.
    const result = await run({
      requestId: 'r-d2',
      userText: 'hi',
      editedScore: undefined,
      history: [],
      deadlineAt: Date.now() + 500,
    })
    expect(result).not.toBeNull()
    if (result && 'fellThrough' in result) {
      expect(result.reason).toBe('deadline_exceeded')
    } else {
      throw new Error('expected fall-through')
    }
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it('runs normally when deadlineAt is comfortably in the future', async () => {
    classifyMock.mockResolvedValue({
      kind: 'refuse',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      reason: 'no',
    })
    const result = await run({
      requestId: 'r-d3',
      userText: 'hi',
      editedScore: undefined,
      history: [],
      deadlineAt: Date.now() + 30_000,
    })
    expect(result).not.toBeNull()
    if (result && 'refused' in result) {
      // got through to classifier → refuse handler.
      expect(result.refused).toBe(true)
    }
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('omitting deadlineAt skips the deadline check (back-compat)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'refuse',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      reason: 'no',
    })
    const result = await run({
      requestId: 'r-d4',
      userText: 'hi',
      editedScore: undefined,
      history: [],
    })
    expect(classifyMock).toHaveBeenCalledTimes(1)
    expect(result).not.toBeNull()
  })
})
