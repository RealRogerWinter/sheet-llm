// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { backfillOrchestratorTurns } from '../../../scripts/backfill-orchestrator-turns'
import {
  messages,
  orchestratorTurns,
  scoreVersions,
  sessions,
  users,
} from '@/lib/db/schema'

/**
 * Unit coverage for the M3.5-PR-7 backfill script.
 *
 * Strategy: build a fresh in-memory DB, seed it with a small session
 * + message + score_versions chain that mimics a "pre-orchestrator-
 * observability" cohort (no orchestrator_turns rows), then run the
 * backfill and assert (a) every assistant message produced exactly
 * one turn row, (b) before/after FKs are wired through, and (c)
 * a second run is a no-op (idempotency).
 */

function seedSession(db: ReturnType<typeof makeTestDb>) {
  db.insert(users).values({ id: 'u1', createdAt: 1, lastSeenAt: 1 }).run()
  db.insert(sessions)
    .values({
      id: 's1',
      userId: 'u1',
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: 1,
    })
    .run()
}

function insertMessage(
  db: ReturnType<typeof makeTestDb>,
  id: string,
  seq: number,
  role: 'user' | 'assistant',
  opts: { createdAt?: number; streamStatus?: string; errorCode?: string } = {},
) {
  db.insert(messages)
    .values({
      id,
      sessionId: 's1',
      seq,
      role,
      contentJson: '[]',
      createdAt: opts.createdAt ?? seq,
      streamStatus: opts.streamStatus ?? 'complete',
      errorCode: opts.errorCode ?? null,
    })
    .run()
}

function insertVersion(
  db: ReturnType<typeof makeTestDb>,
  id: string,
  opts: { messageId?: string; parentVersionId?: string | null } = {},
) {
  db.insert(scoreVersions)
    .values({
      id,
      sessionId: 's1',
      parentVersionId: opts.parentVersionId ?? null,
      scoreJson: '{}',
      scoreHash: `hash-${id}`,
      source: 'llm',
      messageId: opts.messageId ?? null,
      createdAt: 1,
    })
    .run()
}

function countTurns(db: ReturnType<typeof makeTestDb>) {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(orchestratorTurns)
    .get()!.n
}

describe('backfillOrchestratorTurns', () => {
  it('creates one orchestrator_turns row per assistant message', () => {
    const db = makeTestDb()
    seedSession(db)
    insertMessage(db, 'm-user-1', 1, 'user')
    insertMessage(db, 'm-asst-1', 2, 'assistant')
    insertMessage(db, 'm-user-2', 3, 'user')
    insertMessage(db, 'm-asst-2', 4, 'assistant')

    const result = backfillOrchestratorTurns(db)
    expect(result.scanned).toBe(2)
    expect(result.inserted).toBe(2)
    expect(result.skipped).toBe(0)
    expect(countTurns(db)).toBe(2)
  })

  it('wires before/after score_version FKs via messages.score_versions link', () => {
    const db = makeTestDb()
    seedSession(db)
    insertMessage(db, 'm-asst-1', 1, 'assistant')
    insertVersion(db, 'v0')
    insertVersion(db, 'v1', { messageId: 'm-asst-1', parentVersionId: 'v0' })

    backfillOrchestratorTurns(db)
    const turn = db
      .select()
      .from(orchestratorTurns)
      .where(sql`message_id = ${'m-asst-1'}`)
      .get()!
    expect(turn.afterScoreVersionId).toBe('v1')
    expect(turn.beforeScoreVersionId).toBe('v0')
    expect(turn.classificationKind).toBe('unknown')
    expect(turn.handler).toBe('unknown')
    expect(turn.finalStatus).toBe('ok')
  })

  it('records error status when stream_status=errored', () => {
    const db = makeTestDb()
    seedSession(db)
    insertMessage(db, 'm-asst-err', 1, 'assistant', {
      streamStatus: 'errored',
      errorCode: 'upstream_timeout',
    })

    backfillOrchestratorTurns(db)
    const turn = db
      .select()
      .from(orchestratorTurns)
      .where(sql`message_id = ${'m-asst-err'}`)
      .get()!
    expect(turn.finalStatus).toBe('error')
    expect(turn.error).toBe('upstream_timeout')
  })

  it('is idempotent — re-running inserts no duplicates', () => {
    const db = makeTestDb()
    seedSession(db)
    insertMessage(db, 'm-asst-1', 1, 'assistant')
    insertMessage(db, 'm-asst-2', 2, 'assistant')

    const first = backfillOrchestratorTurns(db)
    expect(first.inserted).toBe(2)
    expect(countTurns(db)).toBe(2)

    const second = backfillOrchestratorTurns(db)
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(2)
    expect(countTurns(db)).toBe(2)
  })

  it('skips assistant messages already covered by a live recordTurn row', () => {
    const db = makeTestDb()
    seedSession(db)
    insertMessage(db, 'm-asst-live', 1, 'assistant')
    insertMessage(db, 'm-asst-historical', 2, 'assistant')
    // Simulate a turn recorded LIVE for one message.
    db.insert(orchestratorTurns)
      .values({
        id: 'turn-live',
        sessionId: 's1',
        messageId: 'm-asst-live',
        requestId: 'req-live',
        createdAt: Date.now(),
        latencyMs: 1234,
        finalStatus: 'ok',
        classificationKind: 'compose',
        handler: 'compose',
      })
      .run()

    const result = backfillOrchestratorTurns(db)
    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(1)
    // Live row's request_id is preserved (no overwrite).
    const live = db
      .select()
      .from(orchestratorTurns)
      .where(sql`message_id = ${'m-asst-live'}`)
      .get()!
    expect(live.requestId).toBe('req-live')
    expect(live.classificationKind).toBe('compose')
  })

  it('bounded scan: only loads score_versions for sessions with assistant messages', () => {
    // Build a multi-session DB. Only s1 has an assistant message;
    // s2 has score_versions but no assistant message. After backfill,
    // the turn for s1 must wire through to v1 (its `after` version)
    // and must NOT reference any version belonging to s2 (which the
    // bounded query must have excluded entirely).
    const db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 1, lastSeenAt: 1 }).run()
    db.insert(sessions)
      .values({ id: 's1', userId: 'u1', createdAt: 1, updatedAt: 1, lastMessageAt: 1 })
      .run()
    db.insert(sessions)
      .values({ id: 's2', userId: 'u1', createdAt: 1, updatedAt: 1, lastMessageAt: 1 })
      .run()

    // s1: one assistant message + one linked version (parent v0).
    db.insert(messages)
      .values({
        id: 'm-asst-s1',
        sessionId: 's1',
        seq: 1,
        role: 'assistant',
        contentJson: '[]',
        createdAt: 1,
        streamStatus: 'complete',
      })
      .run()
    db.insert(scoreVersions)
      .values({
        id: 'v0-s1',
        sessionId: 's1',
        parentVersionId: null,
        scoreJson: '{}',
        scoreHash: 'h-v0-s1',
        source: 'llm',
        messageId: null,
        createdAt: 1,
      })
      .run()
    db.insert(scoreVersions)
      .values({
        id: 'v1-s1',
        sessionId: 's1',
        parentVersionId: 'v0-s1',
        scoreJson: '{}',
        scoreHash: 'h-v1-s1',
        source: 'llm',
        messageId: 'm-asst-s1',
        createdAt: 1,
      })
      .run()

    // s2: NO assistant message, but a score_version exists. The
    // bounded scan must skip this entirely.
    db.insert(scoreVersions)
      .values({
        id: 'v0-s2',
        sessionId: 's2',
        parentVersionId: null,
        scoreJson: '{}',
        scoreHash: 'h-v0-s2',
        source: 'llm',
        messageId: null,
        createdAt: 1,
      })
      .run()

    const result = backfillOrchestratorTurns(db)
    expect(result.scanned).toBe(1)
    expect(result.inserted).toBe(1)

    const turn = db
      .select()
      .from(orchestratorTurns)
      .where(sql`message_id = ${'m-asst-s1'}`)
      .get()!
    expect(turn.sessionId).toBe('s1')
    expect(turn.afterScoreVersionId).toBe('v1-s1')
    expect(turn.beforeScoreVersionId).toBe('v0-s1')
    // No turn row should reference any s2 version (sanity: ensure the
    // bounded scan didn't leak unrelated rows into the lookup map).
    const turnsReferencingS2 = db
      .select({ n: sql<number>`count(*)` })
      .from(orchestratorTurns)
      .where(
        sql`before_score_version_id = ${'v0-s2'} OR after_score_version_id = ${'v0-s2'}`,
      )
      .get()!.n
    expect(turnsReferencingS2).toBe(0)
  })

  it('maps message.created_at (seconds) to turn.created_at (ms)', () => {
    const db = makeTestDb()
    seedSession(db)
    insertMessage(db, 'm-asst-1', 1, 'assistant', { createdAt: 1_700_000_000 })

    backfillOrchestratorTurns(db)
    const turn = db
      .select()
      .from(orchestratorTurns)
      .where(sql`message_id = ${'m-asst-1'}`)
      .get()!
    expect(turn.createdAt).toBe(1_700_000_000 * 1000)
  })
})
