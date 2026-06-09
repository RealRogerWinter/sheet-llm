// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setDbForTesting } from '@/lib/db'
import { makeTestDb } from '../../factories/db'
import { users, sessions, scoreVersions, orchestratorTurns } from '@/lib/db/schema'

const { recordTurnOutcome } = await import('@/lib/orchestrator/turnOutcome')

let db: ReturnType<typeof makeTestDb>

/** Seed a user + session + one llm score version + the orchestrator turn
 * that emitted it (afterScoreVersionId = versionId). */
function seedTurn(versionId: string): void {
  db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(sessions)
    .values({ id: 's1', userId: 'u1', createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
    .run()
  db.insert(scoreVersions)
    .values({
      id: versionId,
      sessionId: 's1',
      scoreJson: '{}',
      scoreHash: 'h',
      source: 'llm',
      createdAt: 0,
      schemaVersion: 1,
    })
    .run()
  db.insert(orchestratorTurns)
    .values({
      id: 't1',
      sessionId: 's1',
      requestId: 'r1',
      createdAt: 0,
      latencyMs: 1,
      finalStatus: 'ok',
      afterScoreVersionId: versionId,
    })
    .run()
}

function turnOutcome(): string | null {
  return (
    db
      .select({ outcome: orchestratorTurns.outcome })
      .from(orchestratorTurns)
      .where(eq(orchestratorTurns.id, 't1'))
      .get()?.outcome ?? null
  )
}

beforeEach(() => {
  db = makeTestDb()
  setDbForTesting(db)
})
afterEach(() => {
  setDbForTesting(undefined)
})

describe('recordTurnOutcome (SHE-18 PR1)', () => {
  it('labels the turn whose afterScoreVersionId matches the emitted version', async () => {
    seedTurn('v1')
    await recordTurnOutcome('v1', 'accepted')
    expect(turnOutcome()).toBe('accepted')
  })

  it('is a best-effort no-op (no throw, no change) when no turn emitted that version', async () => {
    seedTurn('v1')
    await expect(recordTurnOutcome('not-a-version', 'reverted')).resolves.toBeUndefined()
    expect(turnOutcome()).toBeNull()
  })

  it('last write wins: a later undo overwrites an earlier accept', async () => {
    seedTurn('v1')
    await recordTurnOutcome('v1', 'accepted')
    await recordTurnOutcome('v1', 'reverted')
    expect(turnOutcome()).toBe('reverted')
  })
})
