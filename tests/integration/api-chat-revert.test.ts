// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Score } from '@/lib/music/types'
import { TEST_USER_ID, installTestDb, mockAuthSession } from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { POST } = await import('@/app/api/chat/revert/route')
const { createConversation, appendMessages } = await import('@/lib/llm/conversations')
const { sessions, orchestratorTurns } = await import('@/lib/db/schema')

function scoreTitled(title: string): Score {
  return {
    title,
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
}

function makePostRequest(body: unknown) {
  return new Request('http://localhost:3000/api/chat/revert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function appendScoreTurn(
  chatId: string,
  toolUseId: string,
  title: string,
): Promise<string> {
  const { newScoreVersionId } = await appendMessages(TEST_USER_ID, chatId, [
    { role: 'user', content: [{ type: 'text', text: `make ${title}` }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'done' },
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'render_score',
          input: scoreTitled(title) as unknown as Record<string, unknown>,
        },
      ],
    },
  ])
  return newScoreVersionId!
}

describe('/api/chat/revert POST — outcome signal (SHE-18 PR1)', () => {
  const { getDb } = installTestDb()

  it('undo → labels the turn that emitted the version being undone as reverted', async () => {
    const chatId = await createConversation(TEST_USER_ID, {})
    await appendScoreTurn(chatId, 'toolu_v1', 'First')
    const v2 = await appendScoreTurn(chatId, 'toolu_v2', 'Second')

    // The /api/chat turn that emitted v2 (the current head) left this row.
    await getDb()
      .insert(orchestratorTurns)
      .values({
        id: crypto.randomUUID(),
        sessionId: chatId,
        requestId: 'r-test',
        createdAt: 0,
        latencyMs: 1,
        finalStatus: 'ok',
        afterScoreVersionId: v2,
      })
      .run()

    // Sanity: head is v2 before the revert.
    const before = await getDb()
      .select({ head: sessions.headVersionId })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(before!.head).toBe(v2)

    // Undo back to the first version.
    const res = await POST(makePostRequest({ chatId, toolUseId: 'toolu_v1' }))
    expect(res.status).toBe(200)

    const turn = await getDb()
      .select({ outcome: orchestratorTurns.outcome })
      .from(orchestratorTurns)
      .where(eq(orchestratorTurns.afterScoreVersionId, v2))
      .get()
    expect(turn!.outcome).toBe('reverted')
  })
})
