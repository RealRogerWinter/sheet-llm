// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'
import type { Score } from '@/lib/music/types'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { GET } = await import('@/app/api/chat/route')
const { POST: postVersion } = await import(
  '@/app/api/sessions/[id]/versions/route'
)
const { createConversation, appendMessages } = await import(
  '@/lib/llm/conversations'
)

const LLM_SCORE: Score = {
  title: 'LLM',
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

function withTitle(s: Score, title: string): Score {
  return { ...s, title }
}

function getReq(chatId: string) {
  return new Request(`http://localhost:3000/api/chat?chatId=${chatId}`, {
    method: 'GET',
  })
}

function versionPost(sessionId: string, body: unknown) {
  return postVersion(
    new Request(`http://localhost:3000/api/sessions/${sessionId}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  )
}

describe('GET /api/chat?chatId= versions[] parent chain', () => {
  installTestDb()

  it('returns oldest→head order with parent links', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    // Seed an LLM checkpoint via appendMessages.
    await appendMessages(TEST_USER_ID, chatId, [
      { role: 'user', content: [{ type: 'text', text: 'gimme a scale' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here it is' },
          {
            type: 'tool_use',
            id: 'toolu_real_1',
            name: 'render_score',
            input: LLM_SCORE as unknown as Record<string, unknown>,
          },
        ],
      },
    ])
    // GET to pick up the LLM-baseline headVersionId.
    const initial = await (await GET(getReq(chatId))).json()
    const v0Id = initial.headVersionId
    expect(v0Id).toBeTruthy()

    // Land two edit versions chained from the baseline.
    const r1 = await versionPost(chatId, {
      parentVersionId: v0Id,
      score: withTitle(LLM_SCORE, 'edit-1'),
      source: 'edit',
      idempotencyKey: 'idem-edit-1',
    })
    const v1 = (await r1.json()).versionId
    const r2 = await versionPost(chatId, {
      parentVersionId: v1,
      score: withTitle(LLM_SCORE, 'edit-2'),
      source: 'edit',
      idempotencyKey: 'idem-edit-2',
    })
    const v2 = (await r2.json()).versionId

    // GET returns the full chain.
    const data = await (await GET(getReq(chatId))).json()
    expect(data.headVersionId).toBe(v2)
    expect(data.versions).toBeDefined()
    expect(data.versions).toHaveLength(3) // baseline + 2 edits
    // Oldest first → head last.
    expect(data.versions[0].id).toBe(v0Id)
    expect(data.versions[0].parentVersionId).toBeNull()
    expect(data.versions[0].source).toBe('llm')
    expect(data.versions[1].id).toBe(v1)
    expect(data.versions[1].parentVersionId).toBe(v0Id)
    expect(data.versions[1].source).toBe('edit')
    expect(data.versions[2].id).toBe(v2)
    expect(data.versions[2].parentVersionId).toBe(v1)
    expect(data.versions[2].source).toBe('edit')
    expect(data.versions[2].scoreJson.title).toBe('edit-2')
  })

  it('omits versions[] when the session has no head', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const data = await (await GET(getReq(chatId))).json()
    // Empty session — no head, no versions, no currentScore.
    expect(data.versions).toBeUndefined()
    expect(data.currentScore).toBeUndefined()
  })

  it('caps at 50 entries on a longer chain', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    await appendMessages(TEST_USER_ID, chatId, [
      { role: 'user', content: [{ type: 'text', text: 'seed' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          {
            type: 'tool_use',
            id: 'toolu_real_seed',
            name: 'render_score',
            input: LLM_SCORE as unknown as Record<string, unknown>,
          },
        ],
      },
    ])
    let parent = (await (await GET(getReq(chatId))).json()).headVersionId as string
    // Land 55 edits — more than the 50 cap.
    for (let i = 0; i < 55; i++) {
      const r = await versionPost(chatId, {
        parentVersionId: parent,
        score: withTitle(LLM_SCORE, `edit-${i}`),
        source: 'edit',
        idempotencyKey: `idem-edit-${i}`,
      })
      parent = (await r.json()).versionId
    }
    const data = await (await GET(getReq(chatId))).json()
    expect(data.versions).toHaveLength(50)
    // Head is the most recent (edit-54); the chain shows the last 50,
    // oldest of which has a parent that's NOT null (it's somewhere
    // mid-chain), confirming we capped the walk.
    expect(data.versions[49].scoreJson.title).toBe('edit-54')
  })
})
