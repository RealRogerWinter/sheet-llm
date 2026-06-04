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

describe('/api/chat debug overrides', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // PR-6 flipped SL_NEW_TOOL_DISPATCH default-on. These debug-override
    // tests assert on the legacy classifier dispatch path's debug
    // surface (classification.kind, handler, etc.); opt out so the
    // classifier mock continues to drive the flow.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    // M25-PR-5 flipped sectional generation default-on; these debug tests
    // exercise the single-shot generate_complex handler explicitly.
    vi.stubEnv('SL_SECTIONAL_GEN', '0')
    // M26: opt out of the free-tier bounded choke point so these debug-surface
    // tests reach the legacy classifier dispatch path they assert on.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'mocked',
      toolUseId: 'toolu_real_1',
    })
    classifyMock.mockReset()
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    runGenerateComplexMock.mockReset()
    runComposeMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('debug.orchestrator=off forces legacy path even when env enables orchestrator', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    const res = await POST(req({ message: 'hi', debug: { orchestrator: 'off' } }))
    expect(res.status).toBe(200)
    expect(classifyMock).not.toHaveBeenCalled()
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('debug.orchestrator=on forces orchestrator path even when env disables it', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const res = await POST(req({ message: 'hi', debug: { orchestrator: 'on' } }))
    expect(res.status).toBe(200)
    expect(classifyMock).toHaveBeenCalledTimes(1)
  })

  it('debug.orchestrator=shadow runs both paths, legacy wins', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    // Use a no-LLM classification so the LLM call counter cleanly
    // reflects ONLY the legacy path.
    classifyMock.mockResolvedValue({
      kind: 'refuse',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      reason: 'shadow-mode probe',
    })
    const res = await POST(req({ message: 'hi', debug: { orchestrator: 'shadow' } }))
    expect(res.status).toBe(200)
    expect(classifyMock).toHaveBeenCalledTimes(1)
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('response includes debug.classification + handler + model + latencyMs when orchestrator ran', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    // Seed a turn first so editedScore can be sent.
    const first = await (await POST(
      req({ message: 'seed', debug: { orchestrator: 'off' } }),
    )).json()
    const res = await POST(req({
      chatId: first.chatId,
      message: 'change key to G',
      editedScore: VALID_SCORE,
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.debug).toBeDefined()
    expect(data.debug.classification.kind).toBe('edit_score_level')
    expect(data.debug.handler).toBe('edit_score_level')
    expect(data.debug.model).toBeNull()
    expect(typeof data.debug.latencyMs).toBe('number')
  })

  it('response debug indicates fall-through when classifier confidence is too low', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // Pro tier: a free-tier fall-through returns a clean 422 now (M26); this
    // test asserts the debug payload's fellThrough flag on the legacy path.
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.3,
    })
    const res = await POST(req({ message: 'maybe' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.debug).toBeDefined()
    expect(data.debug.fellThrough).toBe(true)
  })

  it('response debug present even when orchestrator did not run (mode off) for diagnostics', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const res = await POST(req({ message: 'hi' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    // Debug is always present so the panel can show API-key status
    // and legacy-client choice regardless of orchestrator mode.
    expect(data.debug).toBeDefined()
    expect(data.debug.mode).toBe('off')
    expect(data.debug.handler).toBe('legacy')
    expect(typeof data.debug.keyConfigured).toBe('boolean')
    expect(['real', 'stub']).toContain(data.debug.legacyClient)
  })

  it('debug.modelOverride is passed through to LLM-calling handlers', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    classifyMock.mockResolvedValue({
      kind: 'generate_complex',
      scope: 'long',
      complexity: 'complex',
      confidence: 0.95,
    })
    runGenerateComplexMock.mockResolvedValue({
      score: VALID_SCORE,
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.95,
      },
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 10,
      toolUseId: 'toolu_x',
    })
    const res = await POST(req({
      message: 'go',
      debug: { modelOverride: 'claude-haiku-4-5-20251001' },
    }))
    expect(res.status).toBe(200)
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
    const call = runGenerateComplexMock.mock.calls[0][0]
    expect(call.modelOverride).toBe('claude-haiku-4-5-20251001')
  })

  it('debug.generationTier=pro bypasses the free-tier bounded gate and echoes the resolved tier', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // Bounded gen ON globally; tier=pro must STILL bypass the choke point
    // (it only fires for the free tier) and reach the classifier path —
    // proving the debug toggle flows route -> resolveGenerationTier -> run().
    vi.stubEnv('SL_BOUNDED_GEN', '1')
    classifyMock.mockResolvedValue({
      kind: 'generate_complex',
      scope: 'long',
      complexity: 'complex',
      confidence: 0.95,
    })
    runGenerateComplexMock.mockResolvedValue({
      score: VALID_SCORE,
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.95,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 7,
      toolUseId: 'toolu_pro',
    })
    const res = await POST(
      req({ message: 'write a 16-bar piece', debug: { generationTier: 'pro' } }),
    )
    expect(res.status).toBe(200)
    // Reached the classifier (not the unmocked bounded handler) => pro skipped the gate.
    expect(classifyMock).toHaveBeenCalledTimes(1)
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
    const data = await res.json()
    expect(data.debug.generationTier).toBe('pro')
  })

  it('debug.generationTier=pro is IGNORED in production (paywall bypass fix)', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // The deployed build runs NODE_ENV=production. Without SL_ALLOW_TIER_OVERRIDE
    // a client POSTing debug.generationTier='pro' must NOT unlock pro — the
    // resolved tier falls back to the env default ('free'). Opt out of the
    // bounded gate so the flow reaches the (mocked) classifier path regardless
    // of tier and we can read the echoed resolved tier.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    classifyMock.mockResolvedValue({
      kind: 'generate_complex',
      scope: 'long',
      complexity: 'complex',
      confidence: 0.95,
    })
    runGenerateComplexMock.mockResolvedValue({
      score: VALID_SCORE,
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.95,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 7,
      toolUseId: 'toolu_free',
    })
    const res = await POST(
      req({ message: 'write a 16-bar piece', debug: { generationTier: 'pro' } }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.debug.generationTier).toBe('free')
  })

  it('rejects an invalid debug.generationTier (zod enum)', async () => {
    const res = await POST(req({ message: 'hi', debug: { generationTier: 'platinum' } }))
    expect(res.status).toBe(400)
  })

  it('rejects malformed debug object (zod validation)', async () => {
    const res = await POST(req({ message: 'hi', debug: { orchestrator: 'maybe' } }))
    expect(res.status).toBe(400)
  })
})
