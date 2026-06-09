// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installTestDb, mockAuthSession } from '../factories/testEnv'
import { CLASSIFY_TOOL_NAME } from '@/lib/orchestrator/classifierPrompt'

vi.mock('@/lib/auth/session', () => mockAuthSession())

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
const { orchestratorTurns } = await import('@/lib/db/schema')
const { isNotNull } = await import('drizzle-orm')

const wholeBar = () => ({ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] })
const SEED_SCORE = { key: 'C', meter: '4/4', measures: Array.from({ length: 8 }, wholeBar) }
const PLAN_INPUT = {
  key: 'C',
  meter: '4/4',
  grandStaff: false,
  sections: [
    { label: 'A', bars: 4, hint: 'opening' },
    { label: 'B', bars: 4, hint: 'continuation' },
  ],
}

function toolResp(name: string, input: unknown): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
    usage: { input_tokens: 60, output_tokens: 90 },
  }
}
function classifierResp(): unknown {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_c',
        name: CLASSIFY_TOOL_NAME,
        input: { kind: 'generate_complex', scope: 'long', complexity: 'complex', confidence: 0.95 },
      },
    ],
    usage: { input_tokens: 50, output_tokens: 20 },
  }
}

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const block of text.split('\n\n')) {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length) {
      try {
        frames.push({ event, data: JSON.parse(dataLines.join('\n')) })
      } catch {
        /* skip malformed */
      }
    }
  }
  return frames
}

describe('/api/chat sectional score streaming (M25-PR-4)', () => {
  const { getDb } = installTestDb()
  beforeEach(() => {
    anthropicCreateMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('SL_SECTIONAL_GEN', '1')
    // Sectional streaming is a PRO-tier path — PR-13 clamps the free tier to
    // single-shot even with the bounded handler off — so run as the pro tier.
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    vi.stubEnv('SL_BOUNDED_GEN', '0')
  })

  it('streams section frames then a done frame with the assembled, persisted score', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(classifierResp())
      .mockResolvedValueOnce(toolResp('emit_score_plan', PLAN_INPUT))
      .mockResolvedValueOnce(toolResp('render_score', SEED_SCORE))
      .mockResolvedValueOnce(toolResp('emit_appended_bars', { measures: Array.from({ length: 4 }, wholeBar) }))

    const res = await POST(makeRequest({ message: 'a 12-bar piece in two sections' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-stream-kind')).toBe('score')

    const frames = parseSse(await res.text())
    const sections = frames.filter((f) => f.event === 'section')
    const done = frames.find((f) => f.event === 'done')
    const errors = frames.filter((f) => f.event === 'error')

    expect(errors).toHaveLength(0)
    // Two sections (seed + one extend), rendering progressively 8 -> 12.
    expect(sections).toHaveLength(2)
    expect((sections[0].data.scoreJson as { measures: unknown[] }).measures).toHaveLength(8)
    expect((sections[1].data.scoreJson as { measures: unknown[] }).measures).toHaveLength(12)
    // Terminal done frame carries the finalized, persisted score.
    expect(done).toBeDefined()
    expect((done!.data.scoreJson as { measures: unknown[] }).measures).toHaveLength(12)
    expect(typeof done!.data.abc).toBe('string')
    expect(done!.data.headVersionId).toBeTruthy()
    expect(done!.data.toolUseId).toBeTruthy()
  })

  it('SHE-18 PR1: links the streamed turn to the persisted score version', async () => {
    // Same real streaming flow, but with the turn log ENABLED (the suite
    // default silences it, which skips the DB write). run() writes a real
    // orchestrator_turns row; the streaming persist() must back-fill its
    // after_score_version_id to the assembled score's version.
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '')
    anthropicCreateMock
      .mockResolvedValueOnce(classifierResp())
      .mockResolvedValueOnce(toolResp('emit_score_plan', PLAN_INPUT))
      .mockResolvedValueOnce(toolResp('render_score', SEED_SCORE))
      .mockResolvedValueOnce(
        toolResp('emit_appended_bars', { measures: Array.from({ length: 4 }, wholeBar) }),
      )

    const res = await POST(makeRequest({ message: 'a 12-bar piece in two sections' }))
    expect(res.status).toBe(200)
    const frames = parseSse(await res.text())
    const done = frames.find((f) => f.event === 'done')
    expect(done).toBeDefined()
    const headVersionId = done!.data.headVersionId as string
    expect(headVersionId).toBeTruthy()

    // The DB is fresh per test (installTestDb), so the only linked turn is
    // this request's. It points at the persisted head version — proving the
    // streamed responder back-filled a real (non-seeded) turn row.
    const linked = getDb()
      .select({ after: orchestratorTurns.afterScoreVersionId })
      .from(orchestratorTurns)
      .where(isNotNull(orchestratorTurns.afterScoreVersionId))
      .all()
    expect(linked.length).toBeGreaterThanOrEqual(1)
    expect(linked.some((r) => r.after === headVersionId)).toBe(true)
  })
})
