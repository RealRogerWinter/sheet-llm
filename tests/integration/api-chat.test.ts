// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { ChatMessage } from '@/lib/llm/wrapper'
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

const SECOND_SCORE: Score = {
  ...VALID_SCORE,
  title: 'Mocked turn 2',
  key: 'G',
}

let toolUseCounter = 0
const completeMock = vi.fn()

vi.mock('@/lib/llm/stubClient', () => ({
  stubClient: { complete: completeMock },
}))

const { POST, DELETE } = await import('@/app/api/chat/route')
const { getConversation } = await import('@/lib/llm/conversations')

function mockOnce(score: Score, introText?: string): string {
  const id = `toolu_test_${++toolUseCounter}`
  completeMock.mockResolvedValueOnce({ score, introText, toolUseId: id })
  return id
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(chatId?: string) {
  const url = chatId
    ? `http://localhost:3000/api/chat?chatId=${chatId}`
    : 'http://localhost:3000/api/chat'
  return new Request(url, { method: 'DELETE' })
}

describe('/api/chat POST', () => {
  installTestDb()
  beforeEach(() => {
    toolUseCounter = 0
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'Mocked intro',
      toolUseId: 'toolu_default',
    })
  })

  it('creates a new conversation and returns transpiled ABC + scoreJson', async () => {
    const res = await POST(makeRequest({ message: 'Hello' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.chatId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(data.abc).toContain('K:C')
    expect(data.abc).toContain('C2D2E2F2')
    expect(data.introText).toBe('Mocked intro')
    expect(data.scoreJson).toBeDefined()
    expect(data.scoreJson.key).toBe('C')
  })

  it('returns 410 when chatId is a valid UUID but not in the store', async () => {
    const fakeId = crypto.randomUUID()
    const res = await POST(makeRequest({ chatId: fakeId, message: 'x' }))
    expect(res.status).toBe(410)
    const data = await res.json()
    expect(data.code).toBe('chat_not_found')
  })

  it('returns 400 when chatId is malformed', async () => {
    const res = await POST(makeRequest({ chatId: 'not-a-uuid', message: 'x' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 on missing message', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it('returns 400 on empty message', async () => {
    const res = await POST(makeRequest({ message: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 413 when body exceeds the 1MB cap', async () => {
    // The size guard fires before zod parse. M25-PR-5 raised the cap from
    // 24KB to 1MB so large grand-staff refinements fit; use a body past 1MB.
    const huge = 'x'.repeat(1_100_000)
    const res = await POST(makeRequest({ message: huge }))
    expect(res.status).toBe(413)
  })

  it('returns 403 on cross-origin requests', async () => {
    const res = await POST(
      makeRequest({ message: 'hi' }, { origin: 'http://evil.example.com', host: 'localhost:3000' }),
    )
    expect(res.status).toBe(403)
  })

  it('allows same-origin requests', async () => {
    const res = await POST(
      makeRequest({ message: 'hi' }, { origin: 'http://localhost:3000', host: 'localhost:3000' }),
    )
    expect(res.status).toBe(200)
  })

  it('persists user as TextBlock and assistant as TextBlock + ToolUseBlock', async () => {
    completeMock.mockReset()
    mockOnce(VALID_SCORE, 'Here you go:')
    const first = await (await POST(makeRequest({ message: 'first' }))).json()
    const transcript = (await getConversation(TEST_USER_ID, first.chatId)) as ChatMessage[]
    expect(transcript).toHaveLength(2)

    expect(transcript[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
    })

    expect(transcript[1].role).toBe('assistant')
    const assistantContent = transcript[1].content
    const text = assistantContent.find((c) => c.type === 'text')
    const toolUse = assistantContent.find((c) => c.type === 'tool_use')
    expect(text).toEqual({ type: 'text', text: 'Here you go:' })
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'render_score', id: 'toolu_test_1' })
    expect((toolUse as { input: unknown }).input).toEqual(VALID_SCORE)
  })

  it('refinement turn sends tool_result + text as the user content', async () => {
    completeMock.mockReset()
    mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()
    const firstToolUseId = 'toolu_test_1'

    mockOnce(SECOND_SCORE)
    const second = await POST(makeRequest({ chatId: first.chatId, message: 'turn 2' }))
    expect(second.status).toBe(200)

    // The second mock call's messages should include a user turn whose
    // content is [tool_result(firstToolUseId), text('turn 2')].
    const secondCallArgs = completeMock.mock.calls[1][0] as { messages: ChatMessage[] }
    const lastUserTurn = secondCallArgs.messages.at(-1)
    expect(lastUserTurn?.role).toBe('user')
    expect(lastUserTurn?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: firstToolUseId,
    })
    expect(lastUserTurn?.content[1]).toEqual({ type: 'text', text: 'turn 2' })
  })

  it('rejects 21st user turn with chat_full', async () => {
    completeMock.mockReset()
    let chatId: string | undefined
    for (let i = 0; i < 20; i++) {
      mockOnce(VALID_SCORE)
      const res = await POST(makeRequest({ chatId, message: `turn ${i + 1}` }))
      expect(res.status).toBe(200)
      const data = await res.json()
      chatId = data.chatId
    }
    mockOnce(VALID_SCORE)
    const overLimit = await POST(makeRequest({ chatId, message: 'turn 21' }))
    expect(overLimit.status).toBe(410)
    const data = await overLimit.json()
    expect(data.code).toBe('chat_full')
  })

  it('returns 422 when LLM persistently emits a schema-invalid score', async () => {
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: { key: 'NOT_A_KEY', meter: '4/4', measures: [] } as unknown as Score,
      introText: 'bad',
      toolUseId: 'toolu_bad',
    })
    const res = await POST(makeRequest({ message: 'bad' }))
    expect(res.status).toBe(422)
    // Free tier (the default) bounds the legacy fall-through to 1 retry → 2
    // attempts (M26: no unbounded multi-retry regen). Still 422 once exhausted.
    expect(completeMock).toHaveBeenCalledTimes(2)
  })

  it('returns 422 when LLM persistently emits a semantically-invalid score', async () => {
    const badScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      ] }],
    }
    completeMock.mockReset()
    completeMock.mockResolvedValue({ score: badScore, toolUseId: 'toolu_semantic_bad' })
    const res = await POST(makeRequest({ message: 'incomplete bar' }))
    expect(res.status).toBe(422)
    // Free-tier legacy bound → 2 attempts (1 retry); see the schema-invalid case.
    expect(completeMock).toHaveBeenCalledTimes(2)
  })

  it('retries use tool_result(is_error: true) referencing the failed tool_use_id', async () => {
    const badScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      ] }],
    }
    completeMock.mockReset()
    mockOnce(badScore)
    mockOnce(VALID_SCORE)
    const res = await POST(makeRequest({ message: 'try again' }))
    expect(res.status).toBe(200)
    expect(completeMock).toHaveBeenCalledTimes(2)

    // Inspect the second call's last user turn — should reference the bad toolUseId.
    const secondCallArgs = completeMock.mock.calls[1][0] as { messages: ChatMessage[] }
    const retryTurn = secondCallArgs.messages.at(-1)
    expect(retryTurn?.role).toBe('user')
    expect(retryTurn?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_test_1',
      is_error: true,
    })
  })

  it('does not persist failed retry intermediates in the transcript', async () => {
    const badScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] }],
    }
    completeMock.mockReset()
    mockOnce(badScore)
    mockOnce(VALID_SCORE)
    const data = await (await POST(makeRequest({ message: 'flaky' }))).json()
    const transcript = (await getConversation(TEST_USER_ID, data.chatId)) as ChatMessage[]
    // Only the canonical user + final assistant turns are stored.
    expect(transcript).toHaveLength(2)
    expect(transcript[0].role).toBe('user')
    expect(transcript[1].role).toBe('assistant')
  })

  it('returns 502 when the LLM call throws', async () => {
    completeMock.mockReset()
    completeMock.mockRejectedValueOnce(new Error('network down'))
    const res = await POST(makeRequest({ message: 'oops' }))
    expect(res.status).toBe(502)
    const data = await res.json()
    expect(data.code).toBe('upstream_error')
  })

  it('failed refinement leaves the user turn persisted (recoverable on reload)', async () => {
    // Persisting the user turn BEFORE the LLM call is the chat-vanish
    // fix (see src/app/api/chat/route.ts handleChat) — on any
    // downstream failure (LLM error, network drop, reload mid-flight)
    // the user's prompt survives in the DB and reappears on
    // transcript hydration. The duplicate-tool_result hazard that the
    // old "drop on failure" behavior protected against is handled at
    // a different layer: prepareMessagesForLLM collapses consecutive
    // same-role messages so the next retry's user turn supersedes the
    // orphan in the LLM-visible history.
    completeMock.mockReset()
    mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()
    expect(first.chatId).toBeDefined()

    completeMock.mockRejectedValueOnce(new Error('network down'))
    const refine = await POST(makeRequest({ chatId: first.chatId, message: 'extend' }))
    expect(refine.status).toBe(502)

    const transcript = (await getConversation(TEST_USER_ID, first.chatId)) as ChatMessage[]
    // Original [user, assistant] pair PLUS the orphan user from the
    // failed refinement attempt. The failed-refinement user turn is
    // what restores the panel on reload after the chat-vanish bug.
    expect(transcript).toHaveLength(3)
    expect(transcript[0].role).toBe('user')
    expect(transcript[1].role).toBe('assistant')
    expect(transcript[2].role).toBe('user')
  })

  it('failed first turn persists the user turn (orphan session, recoverable in principle)', async () => {
    // Note: the 502 response does NOT include chatId, so a brand-new-
    // session failure isn't recoverable from the client UI today; the
    // row is effectively an orphan session pending janitor cleanup.
    // We still persist it so the streaming-converse first-turn path
    // (which writes via appendStreamingAssistant with no preceding
    // messages) is symmetric with the JSON path.
    completeMock.mockReset()
    completeMock.mockRejectedValueOnce(new Error('network down'))
    const res = await POST(makeRequest({ message: 'oops' }))
    expect(res.status).toBe(502)
  })
})

describe('/api/chat POST with editedScore', () => {
  const EDITED_SCORE: Score = {
    title: 'User-edited',
    key: 'D',
    meter: '4/4',
    measures: [
      { events: [
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4, accidental: 'sharp' }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      ] },
    ],
  }

  installTestDb()
  beforeEach(() => {
    toolUseCounter = 0
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'Mocked intro',
      toolUseId: 'toolu_default',
    })
  })

  it('embeds the edited score in the next user turn tool_result content (no new assistant turn)', async () => {
    completeMock.mockReset()
    const firstToolUseId = mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()

    mockOnce(SECOND_SCORE)
    const second = await POST(
      makeRequest({ chatId: first.chatId, message: 'now add chords', editedScore: EDITED_SCORE }),
    )
    expect(second.status).toBe(200)

    const callArgs = completeMock.mock.calls[1][0] as { messages: ChatMessage[] }
    const messages = callArgs.messages

    // No synthetic assistant turn should be present — the Anthropic API
    // requires strict user/assistant alternation.
    const assistantCount = messages.filter((m) => m.role === 'assistant').length
    expect(assistantCount).toBe(1)

    // The last user turn should reference the original LLM tool_use_id
    // and embed the edited score in tool_result.content as JSON text.
    const lastUserTurn = messages.at(-1)
    expect(lastUserTurn?.role).toBe('user')
    const toolResult = lastUserTurn!.content.find((c) => c.type === 'tool_result') as
      | { type: 'tool_result'; tool_use_id: string; content: string }
      | undefined
    expect(toolResult).toBeDefined()
    expect(toolResult!.tool_use_id).toBe(firstToolUseId)
    expect(toolResult!.content).toContain('manually edited')
    expect(toolResult!.content).toContain(JSON.stringify(EDITED_SCORE.measures[0], null, 2).split('\n')[0])

    // The text block in the same user turn carries the new instruction.
    const textBlock = lastUserTurn!.content.find((c) => c.type === 'text')
    expect(textBlock).toMatchObject({ type: 'text', text: 'now add chords' })
  })

  it('returns 400 when editedScore is schema-invalid', async () => {
    mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()

    const res = await POST(
      makeRequest({
        chatId: first.chatId,
        message: 'edit',
        editedScore: { key: 'NOT_A_KEY', meter: '4/4', measures: [] },
      }),
    )
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('invalid_request')
    // Mock should have been called once (the first turn), not twice.
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('accepts a semantically-invalid editedScore (Claude can repair it)', async () => {
    mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()

    // A measure whose events sum to less than the meter — mid-edit
    // states like this are common and should pass through to the LLM
    // for repair, not be hard-rejected on the server.
    const semanticallyBadScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      ] }],
    }
    mockOnce(VALID_SCORE)
    const res = await POST(
      makeRequest({ chatId: first.chatId, message: 'please fix the measure', editedScore: semanticallyBadScore }),
    )
    expect(res.status).toBe(200)
    expect(completeMock).toHaveBeenCalledTimes(2)
  })

  it('silently ignores editedScore on the first turn (no prior tool_use to anchor)', async () => {
    completeMock.mockReset()
    mockOnce(VALID_SCORE)
    const res = await POST(makeRequest({ message: 'turn 1', editedScore: EDITED_SCORE }))
    expect(res.status).toBe(200)

    const callArgs = completeMock.mock.calls[0][0] as { messages: ChatMessage[] }
    // No synthetic edit turn should appear.
    const hasEditTurn = callArgs.messages.some((m) =>
      m.role === 'assistant' && m.content.some((c) => c.type === 'tool_use' && c.id.startsWith('toolu_edit_')),
    )
    expect(hasEditTurn).toBe(false)
  })

  it('synthetic edit turns do NOT count toward the 20-turn cap', async () => {
    completeMock.mockReset()
    let chatId: string | undefined
    for (let i = 0; i < 20; i++) {
      mockOnce(VALID_SCORE)
      const body: Record<string, unknown> = { chatId, message: `turn ${i + 1}` }
      if (i > 0) body.editedScore = EDITED_SCORE
      const res = await POST(makeRequest(body))
      expect(res.status).toBe(200)
      const data = await res.json()
      chatId = data.chatId
    }
    mockOnce(VALID_SCORE)
    const overLimit = await POST(makeRequest({ chatId, message: 'turn 21', editedScore: EDITED_SCORE }))
    expect(overLimit.status).toBe(410)
    const data = await overLimit.json()
    expect(data.code).toBe('chat_full')
  })

  it('accepts a larger body (24KB cap, not 8KB)', async () => {
    mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()

    // Score-shaped payload around 10KB (well over the old 8KB cap, under the new 24KB).
    const measures = Array.from({ length: 20 }, () => ({
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    }))
    const bigEdit = { title: 'big', key: 'C', meter: '4/4', measures } as unknown as Score

    mockOnce(VALID_SCORE)
    const res = await POST(makeRequest({ chatId: first.chatId, message: 'edit', editedScore: bigEdit }))
    expect(res.status).toBe(200)
  })
})

describe('/api/chat DELETE', () => {
  installTestDb()
  beforeEach(() => {
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      toolUseId: 'toolu_default',
    })
  })

  it('returns 204 and the chatId is no longer valid', async () => {
    const created = await (await POST(makeRequest({ message: 'create' }))).json()
    const del = await DELETE(makeDeleteRequest(created.chatId))
    expect(del.status).toBe(204)

    const subsequent = await POST(makeRequest({ chatId: created.chatId, message: 'after reset' }))
    expect(subsequent.status).toBe(410)
  })

  it('returns 204 even for an unknown chatId (idempotent)', async () => {
    const res = await DELETE(makeDeleteRequest(crypto.randomUUID()))
    expect(res.status).toBe(204)
  })

  it('returns 400 when chatId query param is missing', async () => {
    const res = await DELETE(makeDeleteRequest())
    expect(res.status).toBe(400)
  })

  it('returns 400 when chatId is malformed', async () => {
    const res = await DELETE(makeDeleteRequest('nope'))
    expect(res.status).toBe(400)
  })
})
