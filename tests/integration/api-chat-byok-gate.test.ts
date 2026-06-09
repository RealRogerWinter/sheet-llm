// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

// SHE-8 PR-3 — the chat route must gate the CLIENT-supplied BYOK fields
// (`debug.apiKey` → apiKeyOverride, `debug.modelOverride`) behind
// isByokKeyAccepted(): honored in dev/test or with the SL_BYOK_ALLOWED self-host
// opt-in, IGNORED on the hosted demo (NODE_ENV=production, no opt-in). We mock
// the orchestrator `run` to capture the exact OrchestratorInput the route builds.

vi.mock('@/lib/auth/session', () => mockAuthSession())

const VALID_SCORE: Score = {
  title: 'OK',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
}

const runMock = vi.fn()
vi.mock('@/lib/orchestrator', async (orig) => ({
  ...(await orig<typeof import('@/lib/orchestrator')>()),
  run: runMock,
}))

const { POST } = await import('@/app/api/chat/route')

function req(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const KEY = 'sk-ant-api03-TESTKEY0123456789'

describe('/api/chat BYOK gate (SHE-8)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    runMock.mockReset()
    runMock.mockResolvedValue({
      score: VALID_SCORE,
      classification: { kind: 'generate_complex', scope: 'short', complexity: 'simple', confidence: 1 },
      model: 'claude-sonnet-4-6',
      latencyMs: 1,
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  function inputArg() {
    expect(runMock).toHaveBeenCalledTimes(1)
    return runMock.mock.calls[0][0] as { apiKeyOverride?: string; modelOverride?: string }
  }

  it('honors debug.apiKey as apiKeyOverride in dev/test', async () => {
    // vitest sets NODE_ENV=test → isByokKeyAccepted() === true
    const res = await POST(req({ message: 'write a short tune', debug: { apiKey: KEY } }))
    expect(res.status).toBe(200)
    expect(inputArg().apiKeyOverride).toBe(KEY)
  })

  it('IGNORES debug.apiKey in production with no opt-in (hosted fail-closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = await POST(req({ message: 'write a short tune', debug: { apiKey: KEY } }))
    expect(res.status).toBe(200)
    expect(inputArg().apiKeyOverride).toBeUndefined()
  })

  it('honors debug.apiKey in production WHEN SL_BYOK_ALLOWED is set (self-host opt-in)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SL_BYOK_ALLOWED', '1')
    await POST(req({ message: 'write a short tune', debug: { apiKey: KEY } }))
    expect(inputArg().apiKeyOverride).toBe(KEY)
  })

  it('gates debug.modelOverride behind the same check (ignored in prod, honored in dev)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await POST(req({ message: 'go', debug: { modelOverride: 'claude-haiku-4-5-20251001' } }))
    expect(inputArg().modelOverride).toBeUndefined()
  })
})
