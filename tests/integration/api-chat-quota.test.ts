// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Score } from '@/lib/music/types'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

// mockAuthSession resolves every request to an ANONYMOUS user (authenticated:false),
// so with the quota flag on these requests take the anon path (IP-keyed; this test
// sets the anon limit to 3 via SL_DAILY_QUOTA_ANON).
vi.mock('@/lib/auth/session', () => mockAuthSession())

const VALID_SCORE: Score = {
  title: 'M',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const completeMock = vi.fn()
vi.mock('@/lib/llm/stubClient', () => ({ stubClient: { complete: completeMock } }))

const { POST } = await import('@/app/api/chat/route')

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7', // TEST-NET-3 → isCfRequest resolves this
      'cf-ray': 'test-ray',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('/api/chat daily-quota gate', () => {
  installTestDb()
  beforeEach(async () => {
    completeMock.mockReset()
    completeMock.mockResolvedValue({ score: VALID_SCORE, introText: 'ok', toolUseId: 'toolu_default' })
    vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '1')
    vi.stubEnv('SL_DAILY_QUOTA_ANON', '3')
    vi.stubEnv('SL_ACCOUNTS_ENABLED', '1')
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
    const { __resetQuotaStateForTesting } = await import('@/lib/orchestrator/dailyQuota')
    __resetQuotaStateForTesting()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('allows up to the anon limit, then 429 quota_exceeded with a CTA + chatId', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(makeRequest({ message: `hi ${i}` }))
      expect(res.status).toBe(200)
    }
    const res = await POST(makeRequest({ message: 'one too many' }))
    expect(res.status).toBe(429)
    const data = await res.json()
    expect(data.code).toBe('quota_exceeded')
    expect(typeof data.error).toBe('string') // plain fallback always present
    expect(data.error.length).toBeGreaterThan(0)
    expect(data.cta).toBeDefined()
    expect(data.cta.kind).toBe('signup')
    expect(data.cta.primaryHref).toBe('/signup')
    expect(data.chatId).toBeTruthy() // client keeps the session to retry
    // the over-limit request never reached the LLM (3 successes called it 3×)
    expect(completeMock).toHaveBeenCalledTimes(3)
  })

  it('is completely inert when the flag is off (no gating, no 429)', async () => {
    vi.stubEnv('SL_DAILY_QUOTA_ENABLED', '')
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeRequest({ message: `hi ${i}` }))
      expect(res.status).toBe(200)
    }
  })
})
