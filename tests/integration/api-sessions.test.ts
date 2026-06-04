// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { GET: listSessions, POST: createSession } = await import(
  '@/app/api/sessions/route'
)
const { createConversation, appendMessages } = await import(
  '@/lib/llm/conversations'
)

function listReq(qs = '') {
  return new Request(`http://localhost:3000/api/sessions${qs}`, { method: 'GET' })
}

function createReq() {
  return new Request('http://localhost:3000/api/sessions', { method: 'POST' })
}

describe('GET /api/sessions', () => {
  installTestDb()

  it('returns an empty array when the user has no sessions', async () => {
    const res = await listSessions(listReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.sessions).toEqual([])
  })

  it('lists the current user\'s sessions sorted by lastMessageAt DESC', async () => {
    const s1 = await createConversation(TEST_USER_ID)
    // Bump s1's lastMessageAt to make timestamps measurably different.
    await appendMessages(TEST_USER_ID, s1, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    await new Promise((r) => setTimeout(r, 1100)) // ts is seconds — wait > 1s
    const s2 = await createConversation(TEST_USER_ID)
    await appendMessages(TEST_USER_ID, s2, [
      { role: 'user', content: [{ type: 'text', text: 'world' }] },
    ])

    const res = await listSessions(listReq())
    const data = await res.json()
    expect(data.sessions).toHaveLength(2)
    expect(data.sessions[0].id).toBe(s2) // most recent first
    expect(data.sessions[1].id).toBe(s1)
    expect(data.sessions[0].preview).toBe('world')
    expect(data.sessions[1].preview).toBe('hi')
  })

  it('does not leak another user\'s sessions', async () => {
    const OTHER = '00000000-0000-0000-0000-000000000099'
    const { users } = await import('@/lib/db/schema')
    const tdb = (await import('@/lib/db')).getDb()
    tdb.insert(users).values({ id: OTHER, createdAt: 0, lastSeenAt: 0 }).run()
    await createConversation(OTHER)
    await createConversation(TEST_USER_ID)

    const res = await listSessions(listReq())
    const data = await res.json()
    expect(data.sessions).toHaveLength(1)
  })

  it('respects the `limit` query parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await createConversation(TEST_USER_ID)
    }
    const res = await listSessions(listReq('?limit=2'))
    const data = await res.json()
    expect(data.sessions).toHaveLength(2)
  })

  it('hides soft-deleted sessions', async () => {
    const s = await createConversation(TEST_USER_ID)
    const { deleteConversation } = await import('@/lib/llm/conversations')
    await deleteConversation(TEST_USER_ID, s)
    const res = await listSessions(listReq())
    const data = await res.json()
    expect(data.sessions).toHaveLength(0)
  })
})

describe('POST /api/sessions', () => {
  installTestDb()

  it('creates a new empty session and returns it as a SessionSummary', async () => {
    const res = await createSession(createReq())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.session.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.session.title).toBeNull()
    expect(data.session.messageCount).toBe(0)
    expect(data.session.headVersionId).toBeNull()
    expect(data.session.forkedFromSessionId).toBeNull()
  })

  it('lists the just-created session in a subsequent GET', async () => {
    const created = await (await createSession(createReq())).json()
    const list = await (await listSessions(listReq())).json()
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0].id).toBe(created.session.id)
  })
})
