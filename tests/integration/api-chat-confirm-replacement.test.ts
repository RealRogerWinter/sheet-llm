// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Score } from '@/lib/music/types'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { POST } = await import('@/app/api/chat/confirm-replacement/route')
const { createConversation, appendMessages } = await import('@/lib/llm/conversations')
const { sessions, scoreVersions } = await import('@/lib/db/schema')

const BASE_SCORE: Score = {
  title: 'Original',
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

const CANDIDATE_SCORE: Score = {
  title: 'New thing',
  key: 'Am',
  meter: '5/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

function makePostRequest(body: unknown) {
  return new Request('http://localhost:3000/api/chat/confirm-replacement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Seed a session with a prior-head score and a candidate-orphan
 * score (the row exists but `sessions.head_version_id` still points
 * at the prior head). Returns the candidate row's id.
 */
async function seedSessionWithCandidate(db: ReturnType<typeof installTestDb>['getDb']): Promise<{
  chatId: string
  priorHeadId: string
  candidateId: string
}> {
  const chatId = await createConversation(TEST_USER_ID, {})
  // First append: seeds the prior-head score (advances head normally).
  await appendMessages(TEST_USER_ID, chatId, [
    {
      role: 'user',
      content: [{ type: 'text', text: 'compose something' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here it is' },
        {
          type: 'tool_use',
          id: 'toolu_test_prior',
          name: 'render_score',
          input: BASE_SCORE as unknown as Record<string, unknown>,
        },
      ],
    },
  ])
  const priorRow = await db()
    .select({ head: sessions.headVersionId })
    .from(sessions)
    .where(eq(sessions.id, chatId))
    .get()
  const priorHeadId = priorRow!.head!

  // Second append: the candidate score row, but with skipHeadVersionBump
  // so the head pointer stays at priorHeadId.
  const { newScoreVersionId } = await appendMessages(
    TEST_USER_ID,
    chatId,
    [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'How about this?' },
          {
            type: 'tool_use',
            id: 'toolu_test_candidate',
            name: 'render_score',
            input: CANDIDATE_SCORE as unknown as Record<string, unknown>,
          },
        ],
      },
    ],
    { skipHeadVersionBump: true },
  )
  return { chatId, priorHeadId, candidateId: newScoreVersionId! }
}

describe('/api/chat/confirm-replacement POST', () => {
  const { getDb } = installTestDb()
  beforeEach(() => {
    // no-op
  })

  it('accept → head moves to candidate', async () => {
    const { chatId, priorHeadId, candidateId } = await seedSessionWithCandidate(getDb)
    expect(candidateId).not.toEqual(priorHeadId)
    const res = await POST(
      makePostRequest({ chatId, candidateVersionId: candidateId, decision: 'accept' }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.headVersionId).toBe(candidateId)
    expect(data.replacementGateSuppressed).toBe(false)

    const after = await getDb()
      .select({ head: sessions.headVersionId, sup: sessions.replacementGateSuppressed })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(after!.head).toBe(candidateId)
    expect(after!.sup).toBe(0)
  })

  it('reject → head stays at prior head + revert row appears', async () => {
    const { chatId, priorHeadId, candidateId } = await seedSessionWithCandidate(getDb)
    const res = await POST(
      makePostRequest({ chatId, candidateVersionId: candidateId, decision: 'reject' }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    // head now points at the revert row, not at the candidate, not at
    // the prior head (the revert row reaffirms the prior head's content).
    expect(data.headVersionId).not.toBe(candidateId)
    expect(data.headVersionId).not.toBe(priorHeadId)

    // A revert row exists; its parent is priorHeadId.
    const revertRow = await getDb()
      .select({
        id: scoreVersions.id,
        parent: scoreVersions.parentVersionId,
        source: scoreVersions.source,
      })
      .from(scoreVersions)
      .where(eq(scoreVersions.id, data.headVersionId))
      .get()
    expect(revertRow!.source).toBe('revert')
    expect(revertRow!.parent).toBe(priorHeadId)

    // session head moved to the revert row.
    const after = await getDb()
      .select({ head: sessions.headVersionId })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(after!.head).toBe(data.headVersionId)
  })

  it('dont_ask_again_this_session → head moves AND suppression flips', async () => {
    const { chatId, candidateId } = await seedSessionWithCandidate(getDb)
    const res = await POST(
      makePostRequest({
        chatId,
        candidateVersionId: candidateId,
        decision: 'dont_ask_again_this_session',
      }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.headVersionId).toBe(candidateId)
    expect(data.replacementGateSuppressed).toBe(true)

    const after = await getDb()
      .select({ head: sessions.headVersionId, sup: sessions.replacementGateSuppressed })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(after!.head).toBe(candidateId)
    expect(after!.sup).toBe(1)
  })

  it('returns 404 for unknown chatId', async () => {
    const res = await POST(
      makePostRequest({
        chatId: crypto.randomUUID(),
        candidateVersionId: crypto.randomUUID(),
        decision: 'accept',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 on malformed body', async () => {
    const res = await POST(
      makePostRequest({ chatId: 'not-a-uuid', candidateVersionId: 'x', decision: 'accept' }),
    )
    expect(res.status).toBe(400)
  })

  it('reject with no prior head → 409 instead of corrupting headVersionId', async () => {
    // Edge case: candidate exists but session.head_version_id is null.
    // Pre-H2-fix this returned 200 with headVersionId:'' which broke
    // downstream type assumptions. Now we surface the inconsistent state
    // as a 409 — it shouldn't be reachable in practice anyway since the
    // gate only fires when a prior score exists.
    const chatId = await createConversation(TEST_USER_ID, {})
    // Seed a candidate row directly without ever advancing the head.
    const candidateId = crypto.randomUUID()
    await getDb()
      .insert(scoreVersions)
      .values({
        id: candidateId,
        sessionId: chatId,
        parentVersionId: null,
        scoreJson: JSON.stringify(CANDIDATE_SCORE),
        scoreHash: 'deadbeef',
        source: 'llm',
        createdAt: Math.floor(Date.now() / 1000),
        schemaVersion: 1,
      })
      .run()
    // Sanity: session head is null.
    const sess = await getDb()
      .select({ head: sessions.headVersionId })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(sess!.head).toBeNull()

    const res = await POST(
      makePostRequest({ chatId, candidateVersionId: candidateId, decision: 'reject' }),
    )
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toMatch(/no prior head/i)
  })
})
