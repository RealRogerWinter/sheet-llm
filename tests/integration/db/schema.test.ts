// @vitest-environment node
// Pure DB tests — skip the jsdom env to save ~800ms of DOM setup per file.

import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { messages, scoreVersions, sessions, users } from '@/lib/db/schema'

const TS = 1_700_000_000

function seedUserAndSession(db: ReturnType<typeof makeTestDb>) {
  db.insert(users)
    .values({
      id: 'u1',
      createdAt: TS,
      lastSeenAt: TS,
    })
    .run()
  db.insert(sessions)
    .values({
      id: 's1',
      userId: 'u1',
      createdAt: TS,
      updatedAt: TS,
      lastMessageAt: TS,
    })
    .run()
}

describe('db schema', () => {
  it('inserts and reads a user with defaults', () => {
    const db = makeTestDb()
    db.insert(users)
      .values({
        id: 'u1',
        createdAt: TS,
        lastSeenAt: TS,
      })
      .run()
    const row = db.select().from(users).where(eq(users.id, 'u1')).get()
    expect(row?.id).toBe('u1')
    expect(row?.externalId).toBeNull()
  })

  it('cascades messages when their session is deleted', () => {
    const db = makeTestDb()
    seedUserAndSession(db)
    db.insert(messages)
      .values({
        id: 'm1',
        sessionId: 's1',
        seq: 0,
        role: 'user',
        contentJson: '[]',
        createdAt: TS,
      })
      .run()
    db.delete(sessions).where(eq(sessions.id, 's1')).run()
    const msg = db.select().from(messages).where(eq(messages.id, 'm1')).get()
    expect(msg).toBeUndefined()
  })

  it('enforces UNIQUE(idempotency_key) on score_versions', () => {
    const db = makeTestDb()
    seedUserAndSession(db)
    db.insert(scoreVersions)
      .values({
        id: 'v1',
        sessionId: 's1',
        scoreJson: '{}',
        scoreHash: 'hash-a',
        source: 'edit',
        idempotencyKey: 'idem-1',
        createdAt: TS,
      })
      .run()
    expect(() =>
      db
        .insert(scoreVersions)
        .values({
          id: 'v2',
          sessionId: 's1',
          scoreJson: '{}',
          scoreHash: 'hash-b',
          source: 'edit',
          idempotencyKey: 'idem-1',
          createdAt: TS + 1,
        })
        .run(),
    ).toThrow(/UNIQUE/i)
  })

  it('enforces UNIQUE(session_id, seq) on messages', () => {
    const db = makeTestDb()
    seedUserAndSession(db)
    db.insert(messages)
      .values({
        id: 'm1',
        sessionId: 's1',
        seq: 0,
        role: 'user',
        contentJson: '[]',
        createdAt: TS,
      })
      .run()
    expect(() =>
      db
        .insert(messages)
        .values({
          id: 'm2',
          sessionId: 's1',
          seq: 0,
          role: 'user',
          contentJson: '[]',
          createdAt: TS + 1,
        })
        .run(),
    ).toThrow(/UNIQUE/i)
  })

  it('allows the same seq across different sessions', () => {
    const db = makeTestDb()
    seedUserAndSession(db)
    db.insert(sessions)
      .values({
        id: 's2',
        userId: 'u1',
        createdAt: TS,
        updatedAt: TS,
        lastMessageAt: TS,
      })
      .run()
    db.insert(messages)
      .values({
        id: 'm1',
        sessionId: 's1',
        seq: 0,
        role: 'user',
        contentJson: '[]',
        createdAt: TS,
      })
      .run()
    expect(() =>
      db
        .insert(messages)
        .values({
          id: 'm2',
          sessionId: 's2',
          seq: 0,
          role: 'user',
          contentJson: '[]',
          createdAt: TS,
        })
        .run(),
    ).not.toThrow()
  })

  it('rejects score_version inserts whose session_id does not exist', () => {
    const db = makeTestDb()
    expect(() =>
      db
        .insert(scoreVersions)
        .values({
          id: 'v1',
          sessionId: 'no-such-session',
          scoreJson: '{}',
          scoreHash: 'h',
          source: 'edit',
          createdAt: TS,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i)
  })

  it('rejects score_version inserts with an invalid `source` (CHECK constraint)', () => {
    const db = makeTestDb()
    seedUserAndSession(db)
    expect(() =>
      db
        .insert(scoreVersions)
        .values({
          id: 'v1',
          sessionId: 's1',
          scoreJson: '{}',
          scoreHash: 'h',
          // Common typo: underscore instead of hyphen — without CHECK this
          // would silently corrupt the data set.
          source: 'fork_seed',
          createdAt: TS,
        })
        .run(),
    ).toThrow(/CHECK|constraint/i)
  })
})
