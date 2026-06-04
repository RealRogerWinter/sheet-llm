// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

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
vi.mock('@/lib/llm', () => ({
  getLLMClient: () => ({ complete: completeMock }),
}))

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) { super(m); this.name = 'ClassifierSchemaError' }
  },
}))

const runEditIntraMeasureMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/editIntraMeasure', () => ({
  runEditIntraMeasure: runEditIntraMeasureMock,
  EditIntraMeasureError: class extends Error {
    constructor(m: string) { super(m); this.name = 'EditIntraMeasureError' }
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

describe('/api/chat orchestrator (Phase 2)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // M26: these predate the bounded free-tier path; exercise the legacy gen route.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    // PR-6 flipped SL_NEW_TOOL_DISPATCH default-on. These Phase 2
    // tests exercise the legacy classifier dispatch path explicitly.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'mocked',
      toolUseId: 'toolu_real_1',
    })
    classifyMock.mockReset()
    runEditIntraMeasureMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('dispatches edit_intra_measure end-to-end', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_intra_measure',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.9,
      target_description: 'raise the third note',
    })
    runEditIntraMeasureMock.mockResolvedValue({
      score: { ...VALID_SCORE, title: 'After intra' },
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 12,
      toolUseId: 'toolu_intra_1',
    })
    // Seed a first turn so editedScore can be sent on turn 2.
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'first' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    const res = await POST(
      req({ chatId: first.chatId, message: 'raise the third note', editedScore: VALID_SCORE }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Orchestrator-Label')).toBe('edit_intra_measure')
    const data = await res.json()
    expect(data.scoreJson.title).toBe('After intra')
    expect(runEditIntraMeasureMock).toHaveBeenCalledTimes(1)
  })

  it('returns 409 stale_score when score_version mismatches the last assistant score', async () => {
    // Seed: first turn gets VALID_SCORE.
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'first' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    // Client claims a different score_version than the server has.
    const res = await POST(
      req({
        chatId: first.chatId,
        message: 'change key to G',
        editedScore: VALID_SCORE,
        score_version: 'definitely-not-the-current-hash',
      }),
    )
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('stale_score')
  })

  it('accepts matching score_version', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'first' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    const currentHash = scoreHash(VALID_SCORE)
    const res = await POST(
      req({
        chatId: first.chatId,
        message: 'change key to G',
        editedScore: VALID_SCORE,
        score_version: currentHash,
      }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.scoreJson.key).toBe('G')
  })

  it('accepts absent score_version (backward compatible)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'first' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    const res = await POST(
      req({ chatId: first.chatId, message: 'change key to G', editedScore: VALID_SCORE }),
    )
    expect(res.status).toBe(200)
  })

  it('ignores score_version on the first turn (no prior assistant score)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    const res = await POST(
      req({ message: 'a c major scale', score_version: 'whatever' }),
    )
    expect(res.status).toBe(200)
  })

  it('ignores score_version when no editedScore is present (no comparison possible)', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'first' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    const res = await POST(
      req({ chatId: first.chatId, message: 'another scale', score_version: 'whatever' }),
    )
    expect(res.status).toBe(200)
  })

  // Regression: a follow-up to a generated score with no manual edits
  // (client omits editedScore because historyPointer === 0) used to leave
  // the orchestrator with `editedScore: undefined`, so the classifier
  // saw SCORE PRESENT: false and refused requests like "add 4 measures
  // with a bridge". Server now falls back to the most recent assistant
  // score from the transcript before dispatching the orchestrator.
  it('passes prior assistant score to orchestrator when client omits editedScore', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_intra_measure',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.9,
      target_description: 'add 4 measures with a bridge',
    })
    runEditIntraMeasureMock.mockResolvedValue({
      score: { ...VALID_SCORE, title: 'Extended' },
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 12,
      toolUseId: 'toolu_intra_1',
    })
    // Seed turn 1 with orchestrator off so a real assistant score lands
    // in the transcript.
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const first = await (await POST(req({ message: 'a c major scale' }))).json()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')

    // Follow-up — client deliberately omits editedScore (user did not
    // manually edit, so the frontend's hasEdits gate is false).
    const res = await POST(
      req({ chatId: first.chatId, message: 'add another 4 measures with a bridge' }),
    )
    expect(res.status).toBe(200)
    expect(runEditIntraMeasureMock).toHaveBeenCalledTimes(1)
    // Handler MUST have received the prior assistant score so the
    // classifier could see SCORE PRESENT: true and the handler had
    // something to patch.
    expect(runEditIntraMeasureMock.mock.calls[0][0].editedScore).toEqual(VALID_SCORE)
  })
})
