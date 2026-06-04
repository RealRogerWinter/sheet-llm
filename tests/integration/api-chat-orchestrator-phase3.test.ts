// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const VALID_SCORE: Score = {
  title: 'OK',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

const completeMock = vi.fn()
vi.mock('@/lib/llm/stubClient', () => ({ stubClient: { complete: completeMock } }))
vi.mock('@/lib/llm', () => ({ getLLMClient: () => ({ complete: completeMock }) }))

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) { super(m); this.name = 'ClassifierSchemaError' }
  },
}))

const runGenerateComplexMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/generateComplex', () => ({
  runGenerateComplex: runGenerateComplexMock,
  _resetGenerateComplexClient: () => undefined,
}))

const runComposeMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/compose', () => ({
  runCompose: runComposeMock,
  _resetComposeClient: () => undefined,
}))

const { POST } = await import('@/app/api/chat/route')

function req(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/chat orchestrator (Phase 3)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // M26: these predate the bounded free-tier path; exercise the legacy gen route.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    // PR-6 flipped SL_NEW_TOOL_DISPATCH default-on. These Phase 3
    // tests exercise the legacy classifier dispatch path explicitly.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    // M25-PR-5 flipped sectional generation default-on; these tests pin
    // the single-shot generate_complex -> runGenerateComplex dispatch.
    vi.stubEnv('SL_SECTIONAL_GEN', '0')
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'mocked',
      toolUseId: 'toolu_real_1',
    })
    classifyMock.mockReset()
    runGenerateComplexMock.mockReset()
    runComposeMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('end-to-end: generate_complex routes to Opus handler with chatId', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_complex',
      scope: 'long',
      complexity: 'complex',
      confidence: 0.95,
    })
    runGenerateComplexMock.mockResolvedValue({
      score: { ...VALID_SCORE, title: 'Opus long' },
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.95,
      },
      model: 'claude-opus-4-7',
      latencyMs: 200,
      toolUseId: 'toolu_opus_1',
    })
    const res = await POST(req({ message: 'write me a long sonata' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBe('generate_complex')
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
    expect(typeof runGenerateComplexMock.mock.calls[0][0].chatId).toBe('string')
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('end-to-end: compose routes to compose handler with editedScore + chatId', async () => {
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: VALID_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-opus-4-7',
      latencyMs: 350,
      toolUseId: 'toolu_compose_1',
    })
    // Seed first turn so editedScore can flow on turn 2.
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'first' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    const res = await POST(req({
      chatId: first.chatId,
      message: 'write a counterpoint to this line',
      editedScore: VALID_SCORE,
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBe('compose')
    expect(runComposeMock).toHaveBeenCalledTimes(1)
    expect(runComposeMock.mock.calls[0][0].editedScore).toEqual(VALID_SCORE)
    expect(runComposeMock.mock.calls[0][0].chatId).toBe(first.chatId)
  })
})
