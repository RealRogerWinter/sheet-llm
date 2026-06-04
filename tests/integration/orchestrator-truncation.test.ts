// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installTestDb, mockAuthSession } from '../factories/testEnv'
import { CLASSIFY_TOOL_NAME } from '@/lib/orchestrator/classifierPrompt'

vi.mock('@/lib/auth/session', () => mockAuthSession())

// Mock the Anthropic SDK so BOTH the classifier and generate calls hit a
// stub. This is the seam the smoke-plan critique flagged as missing: the
// REAL orchestrator (index.ts -> classify -> dispatch -> runGenerateComplex
// -> callWithScoreRetry -> provider) executes; only the network is faked.
const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreateMock }
    constructor() {}
    static APIError = class extends Error {}
    static RateLimitError = class extends Error {}
  }
  return { default: MockAnthropic }
})

const { POST } = await import('@/app/api/chat/route')

function classifierResponse(kind: string): unknown {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_classify',
        name: CLASSIFY_TOOL_NAME,
        input: { kind, scope: 'long', complexity: 'complex', confidence: 0.95 },
      },
    ],
    usage: { input_tokens: 120, output_tokens: 40 },
  }
}

// A generate call that ran past max_tokens: the tool input is truncated
// (here, absent). Pre-fix this produced HTTP 500 "expected array,
// received undefined"; the fix must surface a clean, typed error.
const truncatedGenerate = {
  stop_reason: 'max_tokens',
  content: [{ type: 'tool_use', id: 'toolu_gen', name: 'render_score', input: { title: 'x', key: 'C' } }],
  usage: { input_tokens: 900, output_tokens: 4000 },
}

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/chat orchestrator truncation arm (M25-PR-2)', () => {
  installTestDb()
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // M26: predates the bounded free-tier path; exercise the legacy single-shot
    // generate route that this truncation test pins.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    // This test pins the SINGLE-SHOT generate path's clean-truncation
    // handling (the fallback when sectional generation is off). With
    // sectional ON (the M25-PR-5 default) a fresh generate would stream
    // instead, so disable it here to exercise the non-streamed arm.
    vi.stubEnv('SL_SECTIONAL_GEN', '0')
  })

  it('a fresh large generation that truncates yields a clean 422 — never a cryptic 500', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(classifierResponse('generate_complex'))
      .mockResolvedValueOnce(truncatedGenerate)

    const res = await POST(
      makeRequest({ message: 'a long original solo piano etude in grand staff, 16 bars, with a turnaround' }),
    )

    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('output_too_large')
    expect(String(data.error).toLowerCase()).toContain('too large')
    // The user must NEVER see the raw Zod text or the old 500 framing.
    const blob = JSON.stringify(data)
    expect(blob).not.toContain('expected array')
    expect(blob).not.toContain('Orchestrator failed')
    // Exactly two upstream calls: the classifier + the (truncated) generate.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2)
    // chatId is returned so the client keeps the session (and the orphan
    // user turn does not burn a turn — see countUserTextTurns).
    expect(data.chatId).toBeDefined()
  })
})
