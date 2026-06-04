// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const VALID_SCORE: Score = {
  title: 'Mocked',
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
vi.mock('@/lib/llm/stubClient', () => ({
  stubClient: { complete: completeMock },
}))

const orchestratorRunMock = vi.fn()
vi.mock('@/lib/orchestrator', async () => {
  const real = await vi.importActual<typeof import('@/lib/orchestrator')>('@/lib/orchestrator')
  return { ...real, run: orchestratorRunMock }
})

const { POST } = await import('@/app/api/chat/route')

function req(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/chat orchestrator integration (Phase 0)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_KILL', '')
    vi.stubEnv('ORCHESTRATOR_MODE', '')
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'Mocked intro',
      toolUseId: 'toolu_default',
    })
    orchestratorRunMock.mockReset()
    orchestratorRunMock.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('invokes orchestrator.run with the request details', async () => {
    const res = await POST(req({ message: 'a c major scale' }))
    expect(res.status).toBe(200)
    expect(orchestratorRunMock).toHaveBeenCalledTimes(1)
    const call = orchestratorRunMock.mock.calls[0][0]
    expect(call.userText).toBe('a c major scale')
    expect(typeof call.requestId).toBe('string')
    expect(call.requestId.length).toBeGreaterThan(0)
    expect(call.editedScore).toBeUndefined()
    expect(Array.isArray(call.history)).toBe(true)
  })

  it('falls through to legacy LLM path when orchestrator returns null', async () => {
    const res = await POST(req({ message: 'hi' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    // Legacy path was taken: the mocked stubClient produced the score.
    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(data.scoreJson).toEqual(VALID_SCORE)
  })

  it('uses orchestrator result and SKIPS the legacy LLM when orchestrator returns a Score', async () => {
    const orchestratorScore: Score = {
      title: 'From orchestrator',
      key: 'G',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
      ],
    }
    orchestratorRunMock.mockResolvedValue({
      score: orchestratorScore,
      introText: 'orchestrator did the work',
      classification: {
        kind: 'edit_score_level',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 1,
      },
      model: null,
      latencyMs: 4,
      toolUseId: 'toolu_orchestrator_1',
    })
    const res = await POST(req({ message: 'change key to G' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.scoreJson).toEqual(orchestratorScore)
    expect(data.introText).toBe('orchestrator did the work')
    // Legacy LLM was NOT consulted on the orchestrator path.
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('translates an orchestrator refusal into a 422 with structured reason', async () => {
    orchestratorRunMock.mockResolvedValue({
      refused: true,
      reason: 'Request references a copyrighted song.',
      refusalCode: 'copyright',
      classification: {
        kind: 'refuse',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.95,
        reason: 'Request references a copyrighted song.',
      },
      latencyMs: 1,
    })
    const res = await POST(req({ message: 'Yesterday by The Beatles' }))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('refused')
    expect(data.error).toContain('copyrighted')
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('returns 500 internal_error when the orchestrator throws (primary mode)', async () => {
    orchestratorRunMock.mockRejectedValue(new Error('classifier exploded'))
    const res = await POST(req({ message: 'hi' }))
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.code).toBe('internal_error')
    // M25-PR-2: the raw internal error is logged server-side, NOT leaked
    // to the user. The response carries a generic, safe message.
    expect(data.error).not.toContain('classifier exploded')
    expect(String(data.error).toLowerCase()).toContain('something went wrong')
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('returns 422 validation_failed when orchestrator emits a malformed score', async () => {
    orchestratorRunMock.mockResolvedValue({
      score: { key: 'NOT_A_KEY', meter: '4/4', measures: [] } as unknown as Score,
      classification: { kind: 'edit_score_level', scope: 'snippet', complexity: 'simple', confidence: 1 },
      model: null,
      latencyMs: 1,
    })
    const res = await POST(req({ message: 'change key' }))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('validation_failed')
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('persists an assistant turn with a synth toolu_orch_ id on orchestrator success', async () => {
    const { getConversation } = await import('@/lib/llm/conversations')
    const orchestratorScore: Score = {
      title: 'OK',
      key: 'G',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] }],
    }
    orchestratorRunMock.mockResolvedValue({
      score: orchestratorScore,
      classification: { kind: 'edit_score_level', scope: 'snippet', complexity: 'simple', confidence: 1 },
      model: null,
      latencyMs: 1,
    })
    const res = await POST(req({ message: 'change key to G' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBe('edit_score_level')
    const data = await res.json()
    const transcript = (await getConversation(TEST_USER_ID, data.chatId))!
    const assistant = transcript.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    const toolUse = assistant!.content.find((c) => c.type === 'tool_use') as { id: string } | undefined
    expect(toolUse?.id).toMatch(/^toolu_orch_[A-Za-z0-9]{22}$/)
  })

  it('shadow mode: legacy wins the response, orchestrator outcome is NOT returned', async () => {
    // Clear ENABLED so MODE=shadow controls (explicit false would
    // beat shadow per Phase 5 flag semantics).
    vi.stubEnv('ORCHESTRATOR_ENABLED', '')
    vi.stubEnv('ORCHESTRATOR_MODE', 'shadow')
    const ghostScore: Score = {
      title: 'Ghost (shadow)',
      key: 'D',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] }],
    }
    orchestratorRunMock.mockResolvedValue({
      score: ghostScore,
      classification: { kind: 'edit_score_level', scope: 'snippet', complexity: 'simple', confidence: 1 },
      model: null,
      latencyMs: 1,
    })
    const res = await POST(req({ message: 'change key to D' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    // Legacy mock's VALID_SCORE wins; orchestrator's ghostScore is ignored.
    expect(data.scoreJson).toEqual(VALID_SCORE)
    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(orchestratorRunMock).toHaveBeenCalledTimes(1)
  })

  it('orchestrator does NOT run when ORCHESTRATOR_KILL=1 overrides ENABLED=true', async () => {
    vi.stubEnv('ORCHESTRATOR_KILL', '1')
    const res = await POST(req({ message: 'hi' }))
    expect(res.status).toBe(200)
    expect(orchestratorRunMock).not.toHaveBeenCalled()
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('orchestrator does NOT run when mode is off (default)', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    vi.stubEnv('ORCHESTRATOR_MODE', '')
    const res = await POST(req({ message: 'hi' }))
    expect(res.status).toBe(200)
    expect(orchestratorRunMock).not.toHaveBeenCalled()
    expect(completeMock).toHaveBeenCalledTimes(1)
  })
})
