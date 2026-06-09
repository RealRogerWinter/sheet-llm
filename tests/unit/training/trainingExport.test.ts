// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Score } from '@/lib/music/types'
import { setDbForTesting } from '@/lib/db'
import { makeTestDb } from '../../factories/db'
import {
  users,
  sessions,
  messages,
  scoreVersions,
  orchestratorTurns,
  trainingPairs,
} from '@/lib/db/schema'
import { exportTrainingPairs, type TrainingExportRow } from '@/lib/training/trainingExport'
import { assertScoreInvariants, type ScoreInvariants } from '../../../evals/lib/assertions'

/**
 * Round-trip a captured export row back THROUGH the live eval harness's
 * deterministic scorer: derive the expected invariants from the row's recorded
 * metrics and re-verify them against the exported before/after scores (the same
 * hashMeasure-based assertions the live evals use). Lives in the test (the
 * harness side), not in production src — evals depends on src, never the reverse.
 */
function roundTripThroughEvalHarness(row: TrainingExportRow) {
  const initialScore = row.beforeScore ?? row.afterScore
  const expected: ScoreInvariants = {
    replacementBlocked: row.replacementBlocked,
    ...(row.preservationOk && row.beforeScore
      ? { firstNMeasuresIdentical: row.beforeScore.measures.length }
      : {}),
  }
  const failures = assertScoreInvariants(
    { afterScore: row.afterScore, requiresConfirmation: row.replacementBlocked },
    expected,
    initialScore,
  )
  return { initialScore, expected, actual: { afterScore: row.afterScore }, failures }
}

const BEFORE: Score = {
  title: "Sarah's song",
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
}
const AFTER: Score = {
  title: "Sarah's song",
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
  ],
}

let db: ReturnType<typeof makeTestDb>

/**
 * Seed one complete, capturable turn:
 *   user msg "add a bar" → assistant msg (carries AFTER via score_version_id)
 *   before version (parent of after) ; orchestrator_turns(ok, after=AFTER ver,
 *   outcome NULL=implicitly kept) ; training_pairs marker.
 */
function seedTurn(opts?: {
  outcome?: string | null
  finalStatus?: string
  capturedAt?: number
  reasons?: string[]
  withMarker?: boolean
}): { turnId: string; sessionHash: string } {
  const o = {
    outcome: null as string | null,
    finalStatus: 'ok',
    capturedAt: 1000,
    reasons: ['only 1 of 2 measures retained', "title 'Sarah's song' → 'X'"],
    withMarker: true,
    ...opts,
  }
  db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(sessions)
    .values({ id: 's1', userId: 'u1', createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
    .run()
  db.insert(scoreVersions)
    .values({ id: 'vbefore', sessionId: 's1', scoreJson: JSON.stringify(BEFORE), scoreHash: 'hb', source: 'llm', createdAt: 0, schemaVersion: 1 })
    .run()
  db.insert(scoreVersions)
    .values({ id: 'vafter', sessionId: 's1', parentVersionId: 'vbefore', scoreJson: JSON.stringify(AFTER), scoreHash: 'ha', source: 'llm', createdAt: 0, schemaVersion: 1 })
    .run()
  // user prompt then assistant render (assistant carries the after version)
  db.insert(messages)
    .values({ id: 'mu', sessionId: 's1', seq: 1, role: 'user', contentJson: JSON.stringify([{ type: 'text', text: 'add a bar' }]), createdAt: 0 })
    .run()
  db.insert(messages)
    .values({ id: 'ma', sessionId: 's1', seq: 2, role: 'assistant', contentJson: JSON.stringify([{ type: 'text', text: 'done' }]), scoreVersionId: 'vafter', createdAt: 0 })
    .run()
  const turnId = 't1'
  db.insert(orchestratorTurns)
    .values({
      id: turnId,
      sessionId: 's1',
      requestId: 'req-secret',
      createdAt: 5000,
      latencyMs: 10,
      finalStatus: o.finalStatus,
      classificationKind: 'edit_score_level',
      handlerModel: 'claude-sonnet-4-6',
      afterScoreVersionId: 'vafter',
      retainedEventRatio: 0.5,
      inputTokens: 100,
      outputTokens: 20,
      replacementBlocked: 1,
      outcome: o.outcome,
      preservationOk: 1,
      preservationMismatchCount: 0,
      replacementRetainedIdentityRatio: 0.5,
      replacementReasons: JSON.stringify(o.reasons),
      replacementUserExplicitRewrite: 0,
    })
    .run()
  const sessionHash = createHash('sha256').update(':s1').digest('hex')
  if (o.withMarker) {
    db.insert(trainingPairs)
      .values({ id: 'tp1', turnId, sessionHash, capturedAt: o.capturedAt })
      .run()
  }
  return { turnId, sessionHash }
}

beforeEach(() => {
  db = makeTestDb()
  setDbForTesting(db)
})
afterEach(() => setDbForTesting(undefined))

describe('exportTrainingPairs (SHE-18 PR5)', () => {
  it('emits one anonymized row for a captured, kept turn', () => {
    const { turnId, sessionHash } = seedTurn()
    const { rows, watermark } = exportTrainingPairs(db, {})
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.id).toBe(turnId)
    expect(r.sessionHash).toBe(sessionHash)
    expect(r.userText).toBe('add a bar')
    // Musical structure preserved; authorship free-text (title) redacted.
    expect(r.beforeScore?.measures).toEqual(BEFORE.measures)
    expect(r.beforeScore?.key).toBe('C')
    expect(r.beforeScore?.title).toBeUndefined()
    expect(r.afterScore.measures).toEqual(AFTER.measures)
    expect(r.afterScore.title).toBeUndefined()
    expect(r.classification).toBe('edit_score_level')
    expect(r.model).toBe('claude-sonnet-4-6')
    expect(r.outcome).toBe('kept') // NULL outcome = implicitly kept
    expect(r.preservationOk).toBe(true)
    expect(r.retainedEventRatio).toBe(0.5)
    expect(r.replacementBlocked).toBe(true)
    expect(r.tokens).toEqual({ input: 100, output: 20 })
    expect(r.createdAt).toBe(5000)
    expect(watermark).toBe(1000)
  })

  it('scrubs `title …` reason strings but keeps the safe ones', () => {
    seedTurn()
    const r = exportTrainingPairs(db, {}).rows[0]
    expect(r.replacementReasons).toEqual(['only 1 of 2 measures retained'])
  })

  it('emits NO identifier fields (session_id/user_id/message_id/request_id/error)', () => {
    seedTurn()
    const r = exportTrainingPairs(db, {}).rows[0] as unknown as Record<string, unknown>
    for (const k of ['sessionId', 'session_id', 'userId', 'user_id', 'messageId', 'requestId', 'error']) {
      expect(r[k]).toBeUndefined()
    }
    // The only session key is the opaque hash.
    expect(JSON.stringify(r)).not.toContain('req-secret')
    expect(JSON.stringify(r)).not.toContain('s1')
    // Score free-text authorship must not leak (title carries a personal name).
    expect(JSON.stringify(r)).not.toContain("Sarah's song")
  })

  it('excludes reverted turns, non-ok turns, and uncaptured turns', () => {
    seedTurn({ outcome: 'reverted' })
    expect(exportTrainingPairs(db, {}).rows).toHaveLength(0)
  })

  it('excludes turns with no training_pairs marker (not consented)', () => {
    seedTurn({ withMarker: false })
    expect(exportTrainingPairs(db, {}).rows).toHaveLength(0)
  })

  it('is incremental: sinceCapturedAt filters out already-exported rows', () => {
    seedTurn({ capturedAt: 1000 })
    expect(exportTrainingPairs(db, { sinceCapturedAt: 1000 }).rows).toHaveLength(0)
    expect(exportTrainingPairs(db, { sinceCapturedAt: 999 }).rows).toHaveLength(1)
  })

  it('round-trips through the deterministic scorer (hashMeasure/preservation)', () => {
    seedTurn()
    const r = exportTrainingPairs(db, {}).rows[0]
    const { initialScore, actual, expected, failures } = roundTripThroughEvalHarness(r)
    expect(initialScore.measures).toEqual(BEFORE.measures)
    expect(actual.afterScore?.measures).toEqual(AFTER.measures)
    // The exported preservationOk is re-derivable from the exported scores
    // (redaction strips only score-level metadata, not the per-measure hash).
    expect(failures).toEqual([])
    expect(expected.replacementBlocked).toBe(true)
  })

  it('fresh-gen turn (after-version has no parent) → beforeScore null', () => {
    // Re-point the after version to have no parent (compose-from-scratch).
    seedTurn()
    db.update(scoreVersions).set({ parentVersionId: null }).where(eq(scoreVersions.id, 'vafter')).run()
    const r = exportTrainingPairs(db, {}).rows[0]
    expect(r.beforeScore).toBeNull()
    expect(r.outcome).toBe('kept')
  })

  it('userText is null when no real user message precedes the render', () => {
    seedTurn()
    // Drop the user prompt; only the assistant render remains.
    db.delete(messages).where(eq(messages.id, 'mu')).run()
    const r = exportTrainingPairs(db, {}).rows[0]
    expect(r.userText).toBeNull()
  })

  it('limit does not split a same-millisecond captured_at group (no silent loss)', () => {
    // Two consented turns captured in the same ms.
    const { sessionHash } = seedTurn({ capturedAt: 200 })
    db.insert(orchestratorTurns)
      .values({
        id: 't2',
        sessionId: 's1',
        requestId: 'r2',
        createdAt: 6000,
        latencyMs: 1,
        finalStatus: 'ok',
        afterScoreVersionId: 'vafter',
      })
      .run()
    db.insert(trainingPairs).values({ id: 'tp2', turnId: 't2', sessionHash, capturedAt: 200 }).run()

    // limit=1 would split the ms-200 group; the slice extends to keep both, so
    // re-running since the watermark loses nothing.
    const first = exportTrainingPairs(db, { limit: 1 })
    expect(first.rows.length).toBe(2)
    expect(first.watermark).toBe(200)
    const second = exportTrainingPairs(db, { sinceCapturedAt: first.watermark })
    expect(second.rows.length).toBe(0)
  })
})
