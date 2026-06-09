// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { NeutralMessage } from '@/lib/providers/conversation'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

/**
 * PR A: when the orchestrator serves a turn (synthetic toolu_orch_*
 * id), a subsequent LLM-calling turn must NOT reference the synth id
 * in tool_result (Anthropic would reject — it never produced that
 * id). Instead:
 *  - synth assistant turns + their paired user turns are stripped
 *    from the LLM-visible transcript
 *  - the next refinement anchors against the last REAL tool_use id
 *  - the current score state (via editedScore) carries forward the
 *    synth-applied edits
 */

const SCORE_C: Score = {
  title: 'C major scale',
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

const SCORE_G: Score = { ...SCORE_C, key: 'G', title: 'G major scale' }
const SCORE_D: Score = { ...SCORE_C, key: 'D', title: 'D major scale' }

const completeMock = vi.fn()
vi.mock('@/lib/llm/stubClient', () => ({ stubClient: { complete: completeMock } }))
vi.mock('@/lib/llm', () => ({ getLLMClient: () => ({ complete: completeMock }) }))

// SHE-17: generate_simple is served by the orchestrator via the provider
// registry, so the LLM call is provider.toolCall (not the legacy complete).
const toolCallMock = vi.fn()
vi.mock('@/lib/providers/select', () => ({
  selectProvider: () => ({
    provider: { name: 'anthropic', toolCall: toolCallMock },
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    tier: 'medium',
  }),
}))

/** Queue one generate_simple LLM result (provider.toolCall shape). */
function mockGenTurn(score: Score, introText: string, toolUseId: string) {
  toolCallMock.mockResolvedValueOnce({
    input: score,
    introText,
    toolUseId,
    model: 'claude-sonnet-4-6',
  })
}

/** The neutral history the orchestrator handed to provider.toolCall on call N. */
function historyOfCall(n: number): NeutralMessage[] {
  return toolCallMock.mock.calls[n][1].history as NeutralMessage[]
}

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

describe('/api/chat synth-id stripping (PR A)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    // M26: this synth-id test drives fresh generation through the legacy path;
    // opt out of the free-tier bounded choke point.
    vi.stubEnv('SL_BOUNDED_GEN', '0')
    // These tests drive edits via the classifier (edit_score_level), so opt
    // out of the native tool dispatcher — otherwise an edited-score turn calls
    // the (mocked) provider expecting a dispatch decision and gets a Score.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    completeMock.mockReset()
    toolCallMock.mockReset()
    classifyMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('after a synth orchestrator turn, the next LLM call references the LAST REAL tool_use id, never the synth id', async () => {
    // Pro tier: free-tier fall-throughs return a clean 422 now (M26); the
    // generate_simple → legacy turns here exercise the legacy path mechanism.
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
    // Turn 1: classifier picks generate_simple → legacy LLM path; produces a real tool_use id.
    classifyMock.mockResolvedValueOnce({
      kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.95,
    })
    mockGenTurn(SCORE_C, 'turn 1', 'toolu_REAL_1')
    const t1 = await (await POST(req({ message: 'a c major scale' }))).json()

    // Turn 2: classifier picks edit_score_level → orchestrator handles → synth tool_use id.
    classifyMock.mockResolvedValueOnce({
      kind: 'edit_score_level', scope: 'snippet', complexity: 'simple', confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    await POST(req({ chatId: t1.chatId, message: 'change key to G', editedScore: SCORE_C }))

    // Turn 3: classifier picks generate_simple again → LLM path. The messages
    // sent to the LLM MUST NOT contain a tool_result block pointing at any
    // toolu_orch_* id.
    classifyMock.mockResolvedValueOnce({
      kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.95,
    })
    mockGenTurn(SCORE_D, 'turn 3', 'toolu_REAL_3')
    await POST(req({ chatId: t1.chatId, message: 'now in D major', editedScore: SCORE_G }))

    const sentMessages = historyOfCall(1)
    // The final user turn's tool_result must reference the LAST REAL
    // tool_use id (toolu_REAL_1), not a synth id and not undefined.
    const lastUserTurn = sentMessages.at(-1)
    expect(lastUserTurn?.role).toBe('user')
    const finalToolResult = lastUserTurn?.content.find((c) => c.type === 'tool_result') as
      | { type: 'tool_result'; toolUseId: string }
      | undefined
    expect(finalToolResult).toBeDefined()
    expect(finalToolResult!.toolUseId).toBe('toolu_REAL_1')
    // And NO tool_result anywhere in the transcript should reference a synth id.
    for (const m of sentMessages) {
      if (m.role !== 'user') continue
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          expect(block.toolUseId).not.toMatch(/^toolu_orch_/)
        }
      }
    }
  })

  it('strips synth assistant turns from the LLM-visible transcript', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'pro') // legacy path is pro-tier now (M26)
    classifyMock.mockResolvedValueOnce({
      kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.95,
    })
    mockGenTurn(SCORE_C, 'turn 1', 'toolu_REAL_1')
    const t1 = await (await POST(req({ message: 'a c major scale' }))).json()

    classifyMock.mockResolvedValueOnce({
      kind: 'edit_score_level', scope: 'snippet', complexity: 'simple', confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    await POST(req({ chatId: t1.chatId, message: 'change key to G', editedScore: SCORE_C }))

    classifyMock.mockResolvedValueOnce({
      kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.95,
    })
    mockGenTurn(SCORE_D, 'turn 3', 'toolu_REAL_3')
    await POST(req({ chatId: t1.chatId, message: 'now in D major', editedScore: SCORE_G }))

    const sentMessages = historyOfCall(1)
    const allToolUseIds = sentMessages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_use')
      .map((b) => (b as { id: string }).id)
    expect(allToolUseIds).not.toContain(expect.stringMatching(/^toolu_orch_/))
    for (const id of allToolUseIds) {
      expect(id).not.toMatch(/^toolu_orch_/)
    }
  })

  it('when ALL prior assistant turns are synthetic, the next LLM call uses first-call shape (no tool_result)', async () => {
    // Turn 1: orchestrator-served (synth id) via generate_simple → null because
    // generate_simple needs LLM. Use edit_score_level which needs editedScore →
    // pass it in.
    classifyMock.mockResolvedValueOnce({
      kind: 'edit_score_level', scope: 'snippet', complexity: 'simple', confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    const t1 = await (await POST(req({ message: 'change key to G', editedScore: SCORE_C }))).json()

    // Turn 2: LLM path. Should be first-call shape because no real prior id.
    classifyMock.mockResolvedValueOnce({
      kind: 'generate_simple', scope: 'snippet', complexity: 'simple', confidence: 0.95,
    })
    mockGenTurn(SCORE_D, 'turn 2', 'toolu_REAL_2')
    await POST(req({ chatId: t1.chatId, message: 'rewrite in D major', editedScore: SCORE_G }))

    const sentMessages = historyOfCall(0)
    const lastUserTurn = sentMessages.at(-1)
    expect(lastUserTurn?.role).toBe('user')
    // First-call shape: no tool_result block at all.
    const hasToolResult = lastUserTurn?.content.some((c) => c.type === 'tool_result')
    expect(hasToolResult).toBe(false)
  })
})
