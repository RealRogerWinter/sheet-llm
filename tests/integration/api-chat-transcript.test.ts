// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const SECOND_SCORE: Score = { ...VALID_SCORE, title: 'turn 2', key: 'G' }

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

let toolUseCounter = 0
const completeMock = vi.fn()

vi.mock('@/lib/llm/stubClient', () => ({
  stubClient: { complete: completeMock },
}))

const { POST, GET } = await import('@/app/api/chat/route')

function mockOnce(score: Score, introText?: string): string {
  const id = `toolu_test_${++toolUseCounter}`
  completeMock.mockResolvedValueOnce({ score, introText, toolUseId: id })
  return id
}

function makePost(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeGet(chatId?: string, headers: Record<string, string> = {}) {
  const url = chatId
    ? `http://localhost:3000/api/chat?chatId=${chatId}`
    : 'http://localhost:3000/api/chat'
  return new Request(url, { method: 'GET', headers })
}

describe('/api/chat GET — transcript', () => {
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

  it('400 when chatId query param is missing', async () => {
    const res = await GET(makeGet())
    expect(res.status).toBe(400)
  })

  it('400 when chatId is malformed', async () => {
    const res = await GET(makeGet('not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('404 on a valid UUID that has no transcript', async () => {
    const res = await GET(makeGet(crypto.randomUUID()))
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.code).toBe('chat_not_found')
  })

  it('200 with one user.text + one assistant.render_score turn after a first POST', async () => {
    completeMock.mockReset()
    const firstToolUseId = mockOnce(VALID_SCORE, 'Here you go.')
    const created = await (await POST(makePost({ message: 'turn 1' }))).json()
    const res = await GET(makeGet(created.chatId))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.chatId).toBe(created.chatId)
    expect(data.turns).toHaveLength(2)

    expect(data.turns[0]).toEqual({ role: 'user', kind: 'text', text: 'turn 1' })

    expect(data.turns[1]).toMatchObject({
      role: 'assistant',
      kind: 'render_score',
      introText: 'Here you go.',
      toolUseId: firstToolUseId,
    })
    expect(data.turns[1].scoreSummary).toEqual({
      title: 'Mocked',
      key: 'C',
      meter: '4/4',
      measureCount: 1,
      staffCount: 1,
      voiceCountPerStaff: [1],
    })
    expect(data.turns[1].scoreHash).toBe(scoreHash(VALID_SCORE))
  })

  it('refinement turn carries hadEdit=false without editedScore', async () => {
    completeMock.mockReset()
    const firstToolUseId = mockOnce(VALID_SCORE)
    const first = await (await POST(makePost({ message: 'turn 1' }))).json()
    mockOnce(SECOND_SCORE)
    await POST(makePost({ chatId: first.chatId, message: 'turn 2' }))

    const res = await GET(makeGet(first.chatId))
    const data = await res.json()
    expect(data.turns).toHaveLength(4)
    expect(data.turns[2]).toEqual({
      role: 'user',
      kind: 'refinement',
      text: 'turn 2',
      hadEdit: false,
      toolUseId: firstToolUseId,
    })
  })

  it('refinement turn carries hadEdit=true when editedScore was sent', async () => {
    completeMock.mockReset()
    const firstToolUseId = mockOnce(VALID_SCORE)
    const first = await (await POST(makePost({ message: 'turn 1' }))).json()
    mockOnce(SECOND_SCORE)
    await POST(makePost({ chatId: first.chatId, message: 'turn 2', editedScore: EDITED_SCORE }))

    const res = await GET(makeGet(first.chatId))
    const data = await res.json()
    const refinementTurn = data.turns.find(
      (t: { role: string; kind?: string }) => t.role === 'user' && t.kind === 'refinement',
    )
    expect(refinementTurn).toEqual({
      role: 'user',
      kind: 'refinement',
      text: 'turn 2',
      hadEdit: true,
      toolUseId: firstToolUseId,
    })
  })

  it('returns turns in conversation order', async () => {
    completeMock.mockReset()
    mockOnce(VALID_SCORE, 'one')
    const first = await (await POST(makePost({ message: 'a' }))).json()
    mockOnce(SECOND_SCORE, 'two')
    await POST(makePost({ chatId: first.chatId, message: 'b' }))
    mockOnce(VALID_SCORE, 'three')
    await POST(makePost({ chatId: first.chatId, message: 'c' }))

    const res = await GET(makeGet(first.chatId))
    const data = await res.json()
    expect(data.turns).toHaveLength(6)
    expect(data.turns.map((t: { role: string; kind?: string; text?: string }) =>
      t.role === 'user' ? t.text : t.role,
    )).toEqual(['a', 'assistant', 'b', 'assistant', 'c', 'assistant'])
  })

  it('403 on cross-origin requests', async () => {
    completeMock.mockReset()
    mockOnce(VALID_SCORE)
    const created = await (await POST(makePost({ message: 'x' }))).json()
    const res = await GET(makeGet(created.chatId, { origin: 'http://evil.example.com', host: 'localhost:3000' }))
    expect(res.status).toBe(403)
  })
})

describe('/api/chat POST — toolUseId in response body', () => {
  installTestDb()
  beforeEach(() => {
    toolUseCounter = 0
    completeMock.mockReset()
  })

  it('POST response includes the Anthropic-issued toolUseId', async () => {
    const id = mockOnce(VALID_SCORE)
    const res = await POST(makePost({ message: 'hi' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.toolUseId).toBe(id)
  })
})
