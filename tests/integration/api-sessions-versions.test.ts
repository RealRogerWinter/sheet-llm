// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Score } from '@/lib/music/types'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { POST: postVersion } = await import(
  '@/app/api/sessions/[id]/versions/route'
)
const { POST: postBatch } = await import(
  '@/app/api/sessions/[id]/versions/batch/route'
)
const { createConversation } = await import('@/lib/llm/conversations')
const { sessions, scoreVersions } = await import('@/lib/db/schema')

const SCORE_A: Score = {
  title: 'A',
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
const SCORE_B: Score = { ...SCORE_A, key: 'G', title: 'B' }
const SCORE_C: Score = { ...SCORE_A, key: 'D', title: 'C' }

function singleReq(sessionId: string, body: unknown) {
  return new Request(`http://localhost:3000/api/sessions/${sessionId}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function batchReq(sessionId: string, body: unknown) {
  return new Request(`http://localhost:3000/api/sessions/${sessionId}/versions/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postSingle(sessionId: string, body: unknown) {
  return postVersion(singleReq(sessionId, body), {
    params: Promise.resolve({ id: sessionId }),
  })
}

function postBatchTo(sessionId: string, body: unknown) {
  return postBatch(batchReq(sessionId, body), {
    params: Promise.resolve({ id: sessionId }),
  })
}

describe('POST /api/sessions/:id/versions', () => {
  const tdb = installTestDb()

  it('201s on a first write and bumps session.head_version_id', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const res = await postSingle(chatId, {
      parentVersionId: null,
      score: SCORE_A,
      source: 'edit',
      idempotencyKey: 'edit-1',
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.versionId).toMatch(/^[0-9a-f-]{36}$/)

    const session = tdb
      .getDb()
      .select({ head: sessions.headVersionId })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(session?.head).toBe(data.versionId)
  })

  it('returns the existing versionId on idempotent retry (same key, status 200)', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const body = {
      parentVersionId: null,
      score: SCORE_A,
      source: 'edit',
      idempotencyKey: 'retry-key-1',
    }
    const first = await (await postSingle(chatId, body)).json()
    const res = await postSingle(chatId, body)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.versionId).toBe(first.versionId)
  })

  it('409 stale_parent when the caller\'s parentVersionId doesn\'t match the head', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    // Land a first write to advance the head.
    const first = await (
      await postSingle(chatId, {
        parentVersionId: null,
        score: SCORE_A,
        source: 'edit',
        idempotencyKey: 'k-1',
      })
    ).json()
    // Second write with a stale parent (null, when head is now `first.versionId`).
    const res = await postSingle(chatId, {
      parentVersionId: null,
      score: SCORE_B,
      source: 'edit',
      idempotencyKey: 'k-2',
    })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('stale_parent')
    expect(data.currentHead).toBe(first.versionId)
  })

  it('accepts a write whose parentVersionId matches the current head', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const first = await (
      await postSingle(chatId, {
        parentVersionId: null,
        score: SCORE_A,
        source: 'edit',
        idempotencyKey: 'k-1',
      })
    ).json()
    const second = await postSingle(chatId, {
      parentVersionId: first.versionId,
      score: SCORE_B,
      source: 'edit',
      idempotencyKey: 'k-2',
    })
    expect(second.status).toBe(201)
    const data = await second.json()
    const row = tdb
      .getDb()
      .select({ parentVersionId: scoreVersions.parentVersionId })
      .from(scoreVersions)
      .where(eq(scoreVersions.id, data.versionId))
      .get()
    expect(row?.parentVersionId).toBe(first.versionId)
  })

  it('404 when session does not exist', async () => {
    const res = await postSingle('does-not-exist', {
      parentVersionId: null,
      score: SCORE_A,
      source: 'edit',
      idempotencyKey: 'k',
    })
    expect(res.status).toBe(404)
  })

  it('400 on missing required field (no idempotencyKey)', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const res = await postSingle(chatId, {
      parentVersionId: null,
      score: SCORE_A,
      source: 'edit',
    })
    expect(res.status).toBe(400)
  })

  it('400 on invalid source value (Zod gate before DB CHECK)', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const res = await postSingle(chatId, {
      parentVersionId: null,
      score: SCORE_A,
      source: 'fork_seed', // underscore typo — Zod rejects before DB even sees it
      idempotencyKey: 'k',
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/sessions/:id/versions/batch', () => {
  const tdb = installTestDb()

  it('201s on a batch and chains parent_version_id through the entries', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const res = await postBatchTo(chatId, {
      baseParentVersionId: null,
      versions: [
        { idempotencyKey: 'b-1', score: SCORE_A, source: 'edit' },
        { idempotencyKey: 'b-2', score: SCORE_B, source: 'edit' },
        { idempotencyKey: 'b-3', score: SCORE_C, source: 'edit' },
      ],
    })
    expect(res.status).toBe(201)
    const { versionIds } = await res.json()
    expect(versionIds).toHaveLength(3)

    const rows = tdb
      .getDb()
      .select({
        id: scoreVersions.id,
        parentVersionId: scoreVersions.parentVersionId,
        idemKey: scoreVersions.idempotencyKey,
      })
      .from(scoreVersions)
      .all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(versionIds[0])?.parentVersionId).toBeNull()
    expect(byId.get(versionIds[1])?.parentVersionId).toBe(versionIds[0])
    expect(byId.get(versionIds[2])?.parentVersionId).toBe(versionIds[1])

    const session = tdb
      .getDb()
      .select({ head: sessions.headVersionId })
      .from(sessions)
      .where(eq(sessions.id, chatId))
      .get()
    expect(session?.head).toBe(versionIds[2])
  })

  it('200 short-circuits when all idempotency keys already exist', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const first = await (
      await postBatchTo(chatId, {
        baseParentVersionId: null,
        versions: [
          { idempotencyKey: 'r-1', score: SCORE_A, source: 'edit' },
          { idempotencyKey: 'r-2', score: SCORE_B, source: 'edit' },
        ],
      })
    ).json()
    const res = await postBatchTo(chatId, {
      baseParentVersionId: null,
      versions: [
        { idempotencyKey: 'r-1', score: SCORE_A, source: 'edit' },
        { idempotencyKey: 'r-2', score: SCORE_B, source: 'edit' },
      ],
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.versionIds).toEqual(first.versionIds)
  })

  it('409 stale_parent when baseParentVersionId does not match head', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    await postSingle(chatId, {
      parentVersionId: null,
      score: SCORE_A,
      source: 'edit',
      idempotencyKey: 'pre',
    })
    const res = await postBatchTo(chatId, {
      baseParentVersionId: null, // stale — head was just bumped
      versions: [{ idempotencyKey: 'x', score: SCORE_B, source: 'edit' }],
    })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('stale_parent')
  })

  it('rejects batches over the size cap', async () => {
    const chatId = await createConversation(TEST_USER_ID)
    const versions = Array.from({ length: 65 }, (_, i) => ({
      idempotencyKey: `k-${i}`,
      score: SCORE_A,
      source: 'edit' as const,
    }))
    const res = await postBatchTo(chatId, {
      baseParentVersionId: null,
      versions,
    })
    expect(res.status).toBe(400)
  })
})

describe('cross-user isolation for /api/sessions/:id/versions', () => {
  const tdb = installTestDb()

  it("returns 404 when user A tries to write a version into user B's session", async () => {
    // Seed user B and a session they own.
    const OTHER_USER_ID = '00000000-0000-0000-0000-000000000099'
    const { users } = await import('@/lib/db/schema')
    tdb
      .getDb()
      .insert(users)
      .values({ id: OTHER_USER_ID, createdAt: 0, lastSeenAt: 0 })
      .run()
    const bChatId = await createConversation(OTHER_USER_ID)
    // The mock auth always resolves to TEST_USER_ID, so this POST is
    // user A trying to write into B's session. Should be 404 — the
    // existence of B's session must not leak to A.
    const res = await postSingle(bChatId, {
      parentVersionId: null,
      score: SCORE_A,
      source: 'edit',
      idempotencyKey: 'x',
    })
    expect(res.status).toBe(404)
  })
})
