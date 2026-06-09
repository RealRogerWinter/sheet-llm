// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setDbForTesting } from '@/lib/db'
import { makeTestDb } from '../../factories/db'
import { users, sessions, orchestratorTurns, trainingPairs } from '@/lib/db/schema'
import { trimTrainingPairs } from '@/lib/training/trainingRetention'

let db: ReturnType<typeof makeTestDb>

function seedMarker(id: string, capturedAtMs: number): void {
  db.insert(orchestratorTurns)
    .values({ id: `turn-${id}`, sessionId: 's1', requestId: 'r', createdAt: 0, latencyMs: 1, finalStatus: 'ok' })
    .run()
  db.insert(trainingPairs)
    .values({ id, turnId: `turn-${id}`, sessionHash: 'h', capturedAt: capturedAtMs })
    .run()
}

beforeEach(() => {
  db = makeTestDb()
  db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(sessions).values({ id: 's1', userId: 'u1', createdAt: 0, updatedAt: 0, lastMessageAt: 0 }).run()
  setDbForTesting(db)
})
afterEach(() => setDbForTesting(undefined))

describe('trimTrainingPairs (SHE-18 PR6)', () => {
  it('deletes markers older than the retention window, keeps recent ones', () => {
    const now = Date.now()
    const day = 86_400_000
    seedMarker('old', now - 100 * day)
    seedMarker('recent', now - 1 * day)
    const deleted = trimTrainingPairs(90, db)
    expect(deleted).toBe(1)
    const left = db.select({ id: trainingPairs.id }).from(trainingPairs).all().map((r) => r.id)
    expect(left).toEqual(['recent'])
  })

  it('is idempotent (a second run deletes nothing)', () => {
    seedMarker('old', Date.now() - 200 * 86_400_000)
    expect(trimTrainingPairs(90, db)).toBe(1)
    expect(trimTrainingPairs(90, db)).toBe(0)
  })

  it('does not touch the underlying orchestrator_turns row (markers are independent)', () => {
    seedMarker('old', Date.now() - 200 * 86_400_000)
    trimTrainingPairs(90, db)
    const turn = db.select().from(orchestratorTurns).where(eq(orchestratorTurns.id, 'turn-old')).get()
    expect(turn).toBeDefined() // only the marker is trimmed, not the source-of-truth turn
  })
})
