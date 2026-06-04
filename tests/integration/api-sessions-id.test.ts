// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { PATCH, DELETE } = await import('@/app/api/sessions/[id]/route')
const { createConversation, appendMessages, hasConversation } = await import(
  '@/lib/llm/conversations'
)
const { sessions, users } = await import('@/lib/db/schema')

function patchReq(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost:3000/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function delReq(id: string) {
  return DELETE(
    new Request(`http://localhost:3000/api/sessions/${id}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id }) },
  )
}

describe('PATCH /api/sessions/[id]', () => {
  const tdb = installTestDb()

  it('renames a session and returns the updated summary', async () => {
    const id = await createConversation(TEST_USER_ID)
    const res = await patchReq(id, { title: 'My new song' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.session.id).toBe(id)
    expect(data.session.title).toBe('My new song')
  })

  it('normalizes whitespace-only title to null', async () => {
    const id = await createConversation(TEST_USER_ID)
    await patchReq(id, { title: 'first' })
    const res = await patchReq(id, { title: '   ' })
    const data = await res.json()
    expect(data.session.title).toBeNull()
  })

  it('accepts explicit null to clear the title', async () => {
    const id = await createConversation(TEST_USER_ID)
    await patchReq(id, { title: 'first' })
    const res = await patchReq(id, { title: null })
    const data = await res.json()
    expect(data.session.title).toBeNull()
  })

  it('rejects oversize titles with 400', async () => {
    const id = await createConversation(TEST_USER_ID)
    const big = 'x'.repeat(121)
    const res = await patchReq(id, { title: big })
    expect(res.status).toBe(400)
  })

  it("returns 404 for another user's session (no existence leak)", async () => {
    const OTHER = '00000000-0000-0000-0000-0000000000aa'
    tdb.getDb().insert(users).values({
      id: OTHER, createdAt: 0, lastSeenAt: 0,
    }).run()
    const otherId = await createConversation(OTHER)
    const res = await patchReq(otherId, { title: 'pwned' })
    expect(res.status).toBe(404)
  })

  it('returns 404 for a deleted session', async () => {
    const id = await createConversation(TEST_USER_ID)
    await delReq(id)
    const res = await patchReq(id, { title: 'too late' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/sessions/[id]', () => {
  installTestDb()

  it('204s on success and hides the session from hasConversation', async () => {
    const id = await createConversation(TEST_USER_ID)
    const res = await delReq(id)
    expect(res.status).toBe(204)
    expect(await hasConversation(TEST_USER_ID, id)).toBe(false)
  })

  it('is idempotent — second DELETE still returns 204', async () => {
    const id = await createConversation(TEST_USER_ID)
    await delReq(id)
    const res = await delReq(id)
    expect(res.status).toBe(204)
  })

  it("204s but no-ops on another user's session (no existence leak)", async () => {
    const tdbDb = (await import('@/lib/db')).getDb()
    const OTHER = '00000000-0000-0000-0000-0000000000bb'
    tdbDb.insert(users).values({
      id: OTHER, createdAt: 0, lastSeenAt: 0,
    }).run()
    const otherId = await createConversation(OTHER)
    const res = await delReq(otherId)
    expect(res.status).toBe(204)
    // Other user's row is untouched
    const row = tdbDb
      .select({ deletedAt: sessions.deletedAt })
      .from(sessions)
      .where(eq(sessions.id, otherId))
      .get()
    expect(row?.deletedAt).toBeNull()
  })
})

describe('appendMessages auto-titling', () => {
  const tdb = installTestDb()

  it('sets the title from the first user text turn when title is null', async () => {
    const id = await createConversation(TEST_USER_ID)
    await appendMessages(TEST_USER_ID, id, [
      { role: 'user', content: [{ type: 'text', text: 'A C major scale' }] },
    ])
    const row = tdb
      .getDb()
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get()
    expect(row?.title).toBe('A C major scale')
  })

  it('truncates titles longer than 50 chars', async () => {
    const id = await createConversation(TEST_USER_ID)
    const longText = 'x'.repeat(120)
    await appendMessages(TEST_USER_ID, id, [
      { role: 'user', content: [{ type: 'text', text: longText }] },
    ])
    const row = tdb
      .getDb()
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get()
    expect(row?.title).toBe('x'.repeat(50))
  })

  it('does NOT overwrite a user-set title', async () => {
    const id = await createConversation(TEST_USER_ID)
    await patchReq(id, { title: 'My manual title' })
    await appendMessages(TEST_USER_ID, id, [
      { role: 'user', content: [{ type: 'text', text: 'Different prompt' }] },
    ])
    const row = tdb
      .getDb()
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get()
    expect(row?.title).toBe('My manual title')
  })

  it('does not set a title when the first message has no text block', async () => {
    const id = await createConversation(TEST_USER_ID)
    await appendMessages(TEST_USER_ID, id, [
      {
        role: 'user',
        content: [{ type: 'text', text: '   ' }], // whitespace only → no title
      },
    ])
    const row = tdb
      .getDb()
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get()
    expect(row?.title).toBeNull()
  })
})
