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

const SECOND_SCORE: Score = { ...VALID_SCORE, title: 'turn 2', key: 'G' }

let toolUseCounter = 0
const completeMock = vi.fn()

vi.mock('@/lib/llm/stubClient', () => ({
  stubClient: { complete: completeMock },
}))

const { POST: chatPOST } = await import('@/app/api/chat/route')
const { POST: forkPOST } = await import('@/app/api/chat/fork/route')
const { getConversation } = await import('@/lib/llm/conversations')

function mockOnce(score: Score, introText?: string): string {
  const id = `toolu_test_${++toolUseCounter}`
  completeMock.mockResolvedValueOnce({ score, introText, toolUseId: id })
  return id
}

function makeChatPost(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeForkPost(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/chat/fork', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('/api/chat/fork POST', () => {
  installTestDb()
  beforeEach(() => {
    toolUseCounter = 0
    completeMock.mockReset()
  })

  it('400 on missing fields', async () => {
    const res = await forkPOST(makeForkPost({}))
    expect(res.status).toBe(400)
  })

  it('400 on malformed fromChatId', async () => {
    const res = await forkPOST(
      makeForkPost({ fromChatId: 'not-a-uuid', toolUseId: 'toolu_x' }),
    )
    expect(res.status).toBe(400)
  })

  it('404 when fromChatId is unknown', async () => {
    const res = await forkPOST(
      makeForkPost({ fromChatId: crypto.randomUUID(), toolUseId: 'toolu_x' }),
    )
    expect(res.status).toBe(404)
  })

  it('404 when the toolUseId is not found in the source transcript', async () => {
    const firstId = mockOnce(VALID_SCORE)
    const created = await (await chatPOST(makeChatPost({ message: 'create' }))).json()
    expect(firstId).toBeDefined()
    const res = await forkPOST(
      makeForkPost({ fromChatId: created.chatId, toolUseId: 'toolu_nonexistent' }),
    )
    expect(res.status).toBe(404)
  })

  it('200 returns a new chatId with the chosen score seeded', async () => {
    const firstId = mockOnce(VALID_SCORE)
    const created = await (await chatPOST(makeChatPost({ message: 'create' }))).json()

    const res = await forkPOST(
      makeForkPost({ fromChatId: created.chatId, toolUseId: firstId }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.chatId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(data.chatId).not.toBe(created.chatId)
    expect(data.scoreJson).toEqual(VALID_SCORE)
    expect(data.abc).toContain('K:C')
    expect(data.introText).toBe('Restored from an earlier version.')
    expect(data.toolUseId).toMatch(/^toolu_fork_/)
  })

  it('the forked transcript has user.text + assistant.tool_use seeded, alternation valid', async () => {
    const firstId = mockOnce(VALID_SCORE)
    const created = await (await chatPOST(makeChatPost({ message: 'create' }))).json()

    const res = await forkPOST(
      makeForkPost({ fromChatId: created.chatId, toolUseId: firstId }),
    )
    const data = await res.json()
    const forked = (await getConversation(TEST_USER_ID, data.chatId)) as ChatMessage[]
    expect(forked).toHaveLength(2)
    expect(forked[0].role).toBe('user')
    expect(forked[1].role).toBe('assistant')
    const toolUse = forked[1].content.find((c) => c.type === 'tool_use') as
      | { type: 'tool_use'; id: string; input: unknown }
      | undefined
    expect(toolUse).toBeDefined()
    expect(toolUse!.id).toBe(data.toolUseId)
    expect(toolUse!.input).toEqual(VALID_SCORE)
  })

  it('forking does not mutate the source transcript', async () => {
    mockOnce(VALID_SCORE)
    const created = await (await chatPOST(makeChatPost({ message: 'turn 1' }))).json()
    mockOnce(SECOND_SCORE)
    await chatPOST(makeChatPost({ chatId: created.chatId, message: 'turn 2' }))

    const before = ((await getConversation(TEST_USER_ID, created.chatId)) as ChatMessage[]).slice()

    // Fork from the first toolUseId.
    await forkPOST(makeForkPost({ fromChatId: created.chatId, toolUseId: 'toolu_test_1' }))
    const after = (await getConversation(TEST_USER_ID, created.chatId)) as ChatMessage[]
    expect(after).toHaveLength(before.length)
    // Reference equality is fine here since appendMessages mutates the
    // same array; the count check above is the load-bearing assertion.
    expect(after.length).toBe(before.length)
  })

  it('403 on cross-origin', async () => {
    const firstId = mockOnce(VALID_SCORE)
    const created = await (await chatPOST(makeChatPost({ message: 'x' }))).json()
    const res = await forkPOST(
      makeForkPost(
        { fromChatId: created.chatId, toolUseId: firstId },
        { origin: 'http://evil.example.com', host: 'localhost:3000' },
      ),
    )
    expect(res.status).toBe(403)
  })

  it('next POST against the forked chatId succeeds and alternation is preserved', async () => {
    const firstId = mockOnce(VALID_SCORE)
    const created = await (await chatPOST(makeChatPost({ message: 'turn 1' }))).json()

    const fork = await (await forkPOST(
      makeForkPost({ fromChatId: created.chatId, toolUseId: firstId }),
    )).json()

    // The mock that the next POST will see.
    mockOnce(SECOND_SCORE, 'after restore')
    const refine = await chatPOST(makeChatPost({ chatId: fork.chatId, message: 'now in G' }))
    expect(refine.status).toBe(200)

    // The second call's messages should be [user_seed, assistant_seed, user_refinement].
    const call = completeMock.mock.calls.at(-1)![0] as { messages: ChatMessage[] }
    expect(call.messages).toHaveLength(3)
    expect(call.messages[0].role).toBe('user')
    expect(call.messages[1].role).toBe('assistant')
    expect(call.messages[2].role).toBe('user')
    // The refinement turn references the seeded toolUseId.
    const tr = call.messages[2].content.find((c) => c.type === 'tool_result') as
      | { type: 'tool_result'; tool_use_id: string }
      | undefined
    expect(tr?.tool_use_id).toBe(fork.toolUseId)
  })
})
