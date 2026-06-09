// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const BASE_SCORE: Score = {
  title: 'Base',
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
vi.mock('@/lib/llm', () => ({
  getLLMClient: () => ({ complete: completeMock }),
}))

// SHE-17: generate_simple routes through the provider registry, so mock the
// selected provider's toolCall (the legacy getLLMClient mock above stays for
// the route's bounded/legacy fall-through paths).
const toolCallMock = vi.fn()
vi.mock('@/lib/providers/select', () => ({
  selectProvider: () => ({
    provider: { name: 'anthropic', toolCall: toolCallMock },
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    tier: 'medium',
  }),
}))

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) { super(m); this.name = 'ClassifierSchemaError' }
  },
}))

const { POST } = await import('@/app/api/chat/route')

function req(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/chat orchestrator integration (Phase 1)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // M26: these predate the bounded free-tier path; exercise the legacy gen route.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    // PR-6 flipped SL_NEW_TOOL_DISPATCH default-on. These Phase 1
    // tests exercise the legacy classifier dispatch path explicitly;
    // opt out so the classifier mock continues to drive the flow.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: BASE_SCORE,
      introText: 'mocked',
      toolUseId: 'toolu_real_1',
    })
    toolCallMock.mockReset()
    toolCallMock.mockResolvedValue({
      input: BASE_SCORE,
      introText: 'mocked',
      toolUseId: 'toolu_real_1',
      model: 'claude-sonnet-4-6',
    })
    classifyMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('end-to-end: copyright refusal returns 422 + does not call classifier or LLM', async () => {
    const res = await POST(req({ message: 'Yesterday by The Beatles' }))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('refused')
    expect(data.error).toContain('copyrighted')
    expect(classifyMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('end-to-end: edit_score_level returns updated score without calling LLM', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.97,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    // Seed a conversation with a first turn so editedScore can be passed.
    completeMock.mockResolvedValueOnce({
      score: BASE_SCORE,
      introText: 'first',
      toolUseId: 'toolu_first',
    })
    // Note: orchestrator is off-mode-equivalent for the FIRST call to
    // avoid having to seed editedScore via a separate flow. We'll
    // disable orchestrator for the seed, then re-enable.
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'a c major scale' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    const res = await POST(req({
      chatId: first.chatId,
      message: 'change key to G',
      editedScore: BASE_SCORE,
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBe('edit_score_level')
    const data = await res.json()
    expect(data.scoreJson.key).toBe('G')
    // Only the first (seed) call hit the LLM; the edit was deterministic.
    expect(completeMock).toHaveBeenCalledTimes(1)
    // The deterministic edit handler emits no introText of its own, so
    // route.ts falls back to the canned summary derived from the
    // classifier's score_level_ops.
    expect(data.introText).toBe('Changed key to G')
  })

  it('end-to-end: classifier returns refuse → 422 with classifier reason', async () => {
    classifyMock.mockResolvedValue({
      kind: 'refuse',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      reason: 'off-topic request',
    })
    const res = await POST(req({ message: 'what time is it' }))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('refused')
    expect(data.error).toBe('off-topic request')
  })

  it('end-to-end: generate_simple → orchestrator owns the LLM call, returns score', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    const res = await POST(req({ message: 'a c major scale' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBe('generate_simple')
    // SHE-17: the orchestrator owns the call via the provider registry now.
    expect(toolCallMock).toHaveBeenCalledTimes(1)
    expect(completeMock).not.toHaveBeenCalled()
    const data = await res.json()
    expect(data.scoreJson).toEqual(BASE_SCORE)
  })

  it('end-to-end: low confidence falls through to legacy LLM path (no header, no skip)', async () => {
    // Pro tier: free-tier fall-throughs now return a clean 422 instead of the
    // legacy regen (M26); this test exercises the legacy safety-net mechanism.
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    classifyMock.mockResolvedValue({
      kind: 'edit_intra_measure',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.3,
      target_description: 'unclear',
    })
    const res = await POST(req({ message: 'make it jazzier' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBeNull()
    // Legacy path ran once.
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('end-to-end: classifier schema error falls through to legacy LLM path', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'pro') // legacy safety net is pro-tier now (M26)
    const { ClassifierSchemaError } = await import('@/lib/orchestrator/classifier')
    classifyMock.mockRejectedValue(new ClassifierSchemaError('bad'))
    const res = await POST(req({ message: 'anything' }))
    expect(res.status).toBe(200)
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

})
