// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { reapStalePartials } from '@/lib/db/janitor'
import { messages, sessions, users } from '@/lib/db/schema'

const NOW = 1_700_000_000
const TEN_MIN_S = 600

function seed(db: ReturnType<typeof makeTestDb>) {
  db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(sessions)
    .values({
      id: 's1',
      userId: 'u1',
      createdAt: 0,
      updatedAt: 0,
      lastMessageAt: 0,
    })
    .run()
}

function insertPartial(
  db: ReturnType<typeof makeTestDb>,
  id: string,
  ageSec: number,
) {
  db.insert(messages)
    .values({
      id,
      sessionId: 's1',
      seq: parseInt(id.replace(/\D/g, ''), 10),
      role: 'assistant',
      contentJson: '[]',
      streamStatus: 'partial',
      createdAt: NOW - ageSec,
    })
    .run()
}

function getStatus(db: ReturnType<typeof makeTestDb>, id: string) {
  return db
    .select({
      streamStatus: messages.streamStatus,
      errorCode: messages.errorCode,
    })
    .from(messages)
    .where(eq(messages.id, id))
    .get()
}

describe('reapStalePartials', () => {
  it('marks rows older than `olderThanSec` as errored with stale_partial', () => {
    const db = makeTestDb()
    seed(db)
    insertPartial(db, 'p001', TEN_MIN_S + 60) // 11 min old → stale
    insertPartial(db, 'p002', TEN_MIN_S - 60) // 9 min old → fresh
    insertPartial(db, 'p003', 30) // very recent

    // Pin "now" to NOW for the cutoff calc — bypass real time.
    const cutoff = NOW - TEN_MIN_S
    const result = db.run(sql`
      UPDATE messages
      SET stream_status = 'errored', error_code = 'stale_partial'
      WHERE stream_status = 'partial' AND created_at < ${cutoff}
    `)
    expect(Number(result.changes)).toBe(1)
    expect(getStatus(db, 'p001')).toEqual({
      streamStatus: 'errored',
      errorCode: 'stale_partial',
    })
    expect(getStatus(db, 'p002')?.streamStatus).toBe('partial')
    expect(getStatus(db, 'p003')?.streamStatus).toBe('partial')
  })

  it('is idempotent — second call reaps nothing', () => {
    const db = makeTestDb()
    seed(db)
    // Use Date.now()-relative ages so reapStalePartials' real-time cutoff
    // catches them.
    db.insert(messages)
      .values({
        id: 'p010',
        sessionId: 's1',
        seq: 10,
        role: 'assistant',
        contentJson: '[]',
        streamStatus: 'partial',
        createdAt: 0, // way in the past
      })
      .run()
    const first = reapStalePartials(db, 600)
    expect(first.reaped).toBe(1)
    const second = reapStalePartials(db, 600)
    expect(second.reaped).toBe(0)
  })

  it('does NOT touch complete rows', () => {
    const db = makeTestDb()
    seed(db)
    db.insert(messages)
      .values({
        id: 'c001',
        sessionId: 's1',
        seq: 100,
        role: 'assistant',
        contentJson: '[]',
        streamStatus: 'complete',
        createdAt: 0,
      })
      .run()
    const result = reapStalePartials(db, 600)
    expect(result.reaped).toBe(0)
    expect(getStatus(db, 'c001')?.streamStatus).toBe('complete')
  })

  it('respects custom olderThanSec — 0 reaps every partial', () => {
    const db = makeTestDb()
    seed(db)
    insertPartial(db, 'p100', 1) // 1 second old
    insertPartial(db, 'p101', 5) // 5 seconds old
    const result = reapStalePartials(db, 0)
    expect(result.reaped).toBe(2)
    expect(getStatus(db, 'p100')?.streamStatus).toBe('errored')
    expect(getStatus(db, 'p101')?.streamStatus).toBe('errored')
  })

  it('returns 0 when no partials exist at all', () => {
    const db = makeTestDb()
    seed(db)
    const result = reapStalePartials(db, 0)
    expect(result.reaped).toBe(0)
  })
})
