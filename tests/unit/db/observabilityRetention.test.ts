// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { trimOrchestratorTurns } from '@/lib/db/observabilityRetention'
import { orchestratorTurns, sessions, users } from '@/lib/db/schema'

// orchestrator_turns.created_at is Unix epoch MILLISECONDS — fixtures
// must follow suit so the age-vs-cutoff math matches what
// trimOrchestratorTurns computes.
const NOW_MS = Date.now()
const DAY_MS = 86_400_000

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

function insertTurn(
  db: ReturnType<typeof makeTestDb>,
  id: string,
  ageDays: number,
) {
  db.insert(orchestratorTurns)
    .values({
      id,
      sessionId: 's1',
      requestId: `req-${id}`,
      createdAt: NOW_MS - ageDays * DAY_MS,
      latencyMs: 100,
      finalStatus: 'ok',
    })
    .run()
}

function count(db: ReturnType<typeof makeTestDb>) {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(orchestratorTurns)
    .get()!.n
}

describe('trimOrchestratorTurns', () => {
  it('deletes only rows older than maxAgeDays (default 90)', () => {
    const db = makeTestDb()
    seed(db)
    insertTurn(db, 'old', 100) // 100 days old → trimmed
    insertTurn(db, 'edge', 89) // just under 90 → kept
    insertTurn(db, 'fresh', 1) // very recent → kept

    expect(count(db)).toBe(3)
    const deleted = trimOrchestratorTurns(90, db)
    expect(deleted).toBe(1)
    expect(count(db)).toBe(2)
  })

  it('accepts a custom maxAgeDays', () => {
    const db = makeTestDb()
    seed(db)
    insertTurn(db, 'a', 10)
    insertTurn(db, 'b', 5)
    insertTurn(db, 'c', 1)

    const deleted = trimOrchestratorTurns(7, db)
    expect(deleted).toBe(1) // only 'a' is older than 7 days
    expect(count(db)).toBe(2)
  })

  it('deletes nothing when all rows are fresh', () => {
    const db = makeTestDb()
    seed(db)
    insertTurn(db, 'a', 1)
    insertTurn(db, 'b', 2)

    const deleted = trimOrchestratorTurns(90, db)
    expect(deleted).toBe(0)
    expect(count(db)).toBe(2)
  })

  it('returns 0 on an empty table', () => {
    const db = makeTestDb()
    seed(db)
    expect(trimOrchestratorTurns(90, db)).toBe(0)
  })
})
