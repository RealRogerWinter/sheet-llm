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

// Legacy single-shot path — used to detect whether the route fell through to
// the unbounded legacy generation.
const completeMock = vi.fn()
vi.mock('@/lib/llm/stubClient', () => ({ stubClient: { complete: completeMock } }))
vi.mock('@/lib/llm', () => ({ getLLMClient: () => ({ complete: completeMock }) }))

// Mock the orchestrator entry point so we can return a chosen fall-through
// reason and assert the route's deadline-vs-legacy decision directly.
const runMock = vi.fn()
vi.mock('@/lib/orchestrator', () => ({ run: runMock }))

const { POST } = await import('@/app/api/chat/route')

function req(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/chat — deadline fall-through does not run the unbounded legacy path (M26)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'legacy',
      toolUseId: 'toolu_legacy_1',
    })
    runMock.mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('deadline_exceeded fall-through → clean 503, legacy NOT invoked', async () => {
    runMock.mockResolvedValue({ fellThrough: true, reason: 'deadline_exceeded', latencyMs: 120 })
    const res = await POST(req({ message: 'write a long piece', debug: { orchestrator: 'on' } }))
    expect(res.status).toBe(503)
    const data = await res.json()
    expect(data.code).toBe('deadline_exceeded')
    // The whole point: we did NOT burn more wall-clock on a second full generation.
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('a non-deadline FREE-tier fall-through returns a clean 422, NOT the slow legacy regen', async () => {
    runMock.mockResolvedValue({ fellThrough: true, reason: 'low_confidence', latencyMs: 40 })
    const res = await POST(req({ message: 'maybe do something', debug: { orchestrator: 'on' } }))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('refused')
    // The whole point: free tier does NOT run the slow/garbage legacy regen.
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('a PRO-tier fall-through STILL uses legacy as the safety net (200)', async () => {
    runMock.mockResolvedValue({ fellThrough: true, reason: 'low_confidence', latencyMs: 40 })
    const res = await POST(
      req({ message: 'maybe do something', debug: { orchestrator: 'on', generationTier: 'pro' } }),
    )
    expect(res.status).toBe(200)
    expect(completeMock).toHaveBeenCalledTimes(1)
  })
})
