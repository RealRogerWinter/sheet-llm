import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  logTurn,
  logShadowDivergence,
  recordTurn,
  linkTurnScoreVersion,
} from '@/lib/orchestrator/observability'
import { eq } from 'drizzle-orm'
import { captureTrainingPair } from '@/lib/orchestrator/trainingCapture'
import { orchestratorTurns, scoreVersions, sessions, trainingPairs, users } from '@/lib/db/schema'
import { setDbForTesting } from '@/lib/db'
import { makeTestDb } from '../../factories/db'
import type { Score } from '@/lib/music/types'

const SCORE_A: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [{ kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }],
    },
  ],
}

const SCORE_B: Score = {
  key: 'G',
  meter: '4/4',
  measures: [
    {
      events: [{ kind: 'note', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' }],
    },
  ],
}

describe('orchestrator/observability', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Global setup silences output via ORCHESTRATOR_LOG_SILENT=1.
    // Override for these tests so we can assert on the JSON payload.
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  // SHE-8 never-log invariant — a BYOK provider key must never reach the turn
  // log, even when it leaks into an `error` string from an upstream provider.
  it('redacts a provider API key from the logTurn line (never-log invariant)', () => {
    const KEY = 'sk-ant-api03-ABCDEF0123456789abcdef'
    logTurn({
      requestId: 'req-secret',
      label: 'compose',
      handler: 'generateComplex',
      model: 'claude-sonnet-4-6',
      latencyMs: 9,
      finalStatus: 'error',
      error: `Anthropic 401: invalid x-api-key ${KEY} rejected`,
    })
    const line = logSpy.mock.calls[0][0] as string
    expect(line).not.toContain('sk-ant-')
    expect(line).not.toContain(KEY)
    expect(line).toContain('[redacted]')
  })

  it('redacts a provider API key from the logShadowDivergence line', () => {
    logShadowDivergence({
      requestId: 'req-shadow',
      // a contrived field carrying a key (any future field could)
      // @ts-expect-error — exercising the full-line redaction, not the typed shape
      note: 'leaked gsk_ABCDEF0123456789abcdef in shadow path',
    })
    const line = logSpy.mock.calls[0][0] as string
    expect(line).not.toContain('gsk_ABCDEF')
    expect(line).toContain('[redacted]')
  })

  it('emits a single JSON line to stdout with the orchestrator marker', () => {
    logTurn({
      requestId: 'req-abc',
      label: 'generate_simple',
      handler: 'generateSimple',
      model: 'claude-sonnet-4-6',
      latencyMs: 1234,
      finalStatus: 'ok',
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const arg = logSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(arg)
    expect(parsed.evt).toBe('orchestrator.turn')
    expect(parsed.requestId).toBe('req-abc')
    expect(parsed.label).toBe('generate_simple')
    expect(parsed.handler).toBe('generateSimple')
    expect(parsed.model).toBe('claude-sonnet-4-6')
    expect(parsed.latencyMs).toBe(1234)
    expect(parsed.finalStatus).toBe('ok')
  })

  it('includes optional fields when provided', () => {
    logTurn({
      requestId: 'req-xyz',
      label: 'edit_score_level',
      handler: 'editScoreLevel',
      model: null,
      latencyMs: 5,
      confidence: 0.92,
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      opValidationErrors: 0,
      finalStatus: 'ok',
    })
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(parsed.confidence).toBe(0.92)
    expect(parsed.inputTokens).toBe(100)
    expect(parsed.cachedInputTokens).toBe(80)
    expect(parsed.outputTokens).toBe(20)
    expect(parsed.opValidationErrors).toBe(0)
    expect(parsed.model).toBeNull()
  })

  it('includes the generationTier when provided (M26 diagnostic)', () => {
    logTurn({
      requestId: 'req-tier',
      label: 'compose',
      handler: 'generateBounded',
      model: 'claude-sonnet-4-6',
      latencyMs: 7,
      finalStatus: 'ok',
      generationTier: 'free',
    })
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).generationTier).toBe('free')
  })

  it('emits a timestamp', () => {
    logTurn({
      requestId: 'req-ts',
      label: 'refuse',
      handler: 'refuse',
      model: null,
      latencyMs: 0,
      finalStatus: 'refused',
    })
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(typeof parsed.ts).toBe('string')
    expect(() => new Date(parsed.ts)).not.toThrow()
  })

  it('is silent when ORCHESTRATOR_LOG_SILENT=1 (test runs)', () => {
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    logTurn({
      requestId: 'req-silent',
      label: 'generate_simple',
      handler: 'generateSimple',
      model: null,
      latencyMs: 0,
      finalStatus: 'ok',
    })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('logShadowDivergence emits the shadow_divergence event', () => {
    logShadowDivergence({
      requestId: 'req-shadow',
      label: 'edit_score_level',
      diverged: true,
      reason: 'different_score',
      latencyMsOrchestrator: 12,
      latencyMsLegacy: 1234,
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(parsed.evt).toBe('orchestrator.shadow_divergence')
    expect(parsed.diverged).toBe(true)
    expect(parsed.reason).toBe('different_score')
    expect(parsed.latencyMsOrchestrator).toBe(12)
    expect(parsed.latencyMsLegacy).toBe(1234)
  })

  it('logShadowDivergence is silent when ORCHESTRATOR_LOG_SILENT=1', () => {
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    logShadowDivergence({
      requestId: 'req-silent',
      label: 'generate_simple',
      diverged: false,
    })
    expect(logSpy).not.toHaveBeenCalled()
  })
})

describe('recordTurn — DB persistence', () => {
  let db: ReturnType<typeof makeTestDb>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '')
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    db.insert(sessions)
      .values({
        id: 'session-1',
        userId: 'u1',
        createdAt: 0,
        updatedAt: 0,
        lastMessageAt: 0,
      })
      .run()
    setDbForTesting(db)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    setDbForTesting(undefined)
    vi.unstubAllEnvs()
  })

  function countRows() {
    return db.select({ n: sql<number>`count(*)` }).from(orchestratorTurns).get()!.n
  }

  it('inserts a row when sessionId is present', async () => {
    await recordTurn({
      requestId: 'req-1',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'compose',
      model: 'claude-opus-4-7',
      latencyMs: 8200,
      finalStatus: 'ok',
      confidence: 0.92,
      beforeScore: SCORE_A,
      afterScore: SCORE_A,
    })
    expect(countRows()).toBe(1)
    const row = db.select().from(orchestratorTurns).get()
    expect(row?.sessionId).toBe('session-1')
    expect(row?.requestId).toBe('req-1')
    expect(row?.classificationKind).toBe('compose')
    expect(row?.handlerModel).toBe('claude-opus-4-7')
    expect(row?.finalStatus).toBe('ok')
    expect(row?.classificationConfidence).toBeCloseTo(0.92)
    expect(row?.measureCountBefore).toBe(1)
    expect(row?.measureCountAfter).toBe(1)
    expect(row?.retainedEventRatio).toBe(1)
    expect(row?.keyChanged).toBe(0)
    expect(row?.diffAlgoVersion).toBe(2)
  })

  it('persists preservation + replacement quality detail (SHE-18 PR3)', async () => {
    await recordTurn({
      requestId: 'req-q',
      sessionId: 'session-1',
      label: 'edit_score_level',
      handler: 'extend_composition',
      model: 'claude-sonnet-4-6',
      latencyMs: 10,
      finalStatus: 'ok',
      preservationOk: true,
      preservationMismatchCount: 0,
      replacementRetainedIdentityRatio: 0.83,
      replacementReasons: ['key C → Am', 'meter 4/4 → 5/4'],
      replacementUserExplicitRewrite: false,
    })
    const row = db.select().from(orchestratorTurns).get()
    expect(row?.preservationOk).toBe(1)
    expect(row?.preservationMismatchCount).toBe(0)
    expect(row?.replacementRetainedIdentityRatio).toBeCloseTo(0.83)
    expect(JSON.parse(row!.replacementReasons!)).toEqual(['key C → Am', 'meter 4/4 → 5/4'])
    expect(row?.replacementUserExplicitRewrite).toBe(0)
  })

  it('leaves quality-detail columns NULL when not provided (no before-score)', async () => {
    await recordTurn({
      requestId: 'req-q2',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'compose',
      model: null,
      latencyMs: 5,
      finalStatus: 'ok',
    })
    const row = db.select().from(orchestratorTurns).get()
    expect(row?.preservationOk).toBeNull()
    expect(row?.preservationMismatchCount).toBeNull()
    expect(row?.replacementRetainedIdentityRatio).toBeNull()
    expect(row?.replacementReasons).toBeNull()
    expect(row?.replacementUserExplicitRewrite).toBeNull()
  })

  it('also emits a stdout line alongside the DB insert', async () => {
    await recordTurn({
      requestId: 'req-2',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'compose',
      model: 'claude-opus-4-7',
      latencyMs: 50,
      finalStatus: 'ok',
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(parsed.evt).toBe('orchestrator.turn')
  })

  it('skips DB insert when sessionId is missing', async () => {
    await recordTurn({
      requestId: 'req-3',
      label: 'compose',
      handler: 'compose',
      model: null,
      latencyMs: 5,
      finalStatus: 'fell_through',
    })
    expect(countRows()).toBe(0)
    expect(logSpy).toHaveBeenCalledTimes(1) // stdout still happens
  })

  it("skips DB insert when sessionId is 'anonymous'", async () => {
    await recordTurn({
      requestId: 'req-4',
      sessionId: 'anonymous',
      label: 'compose',
      handler: 'compose',
      model: null,
      latencyMs: 5,
      finalStatus: 'ok',
    })
    expect(countRows()).toBe(0)
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('skips both stdout and DB when ORCHESTRATOR_LOG_SILENT=1', async () => {
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    await recordTurn({
      requestId: 'req-5',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'compose',
      model: null,
      latencyMs: 5,
      finalStatus: 'ok',
    })
    expect(countRows()).toBe(0)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('records the score-diff payload when both before and after are present', async () => {
    await recordTurn({
      requestId: 'req-6',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'compose',
      model: 'claude-opus-4-7',
      latencyMs: 100,
      finalStatus: 'ok',
      beforeScore: SCORE_A,
      afterScore: SCORE_B,
    })
    const row = db.select().from(orchestratorTurns).get()
    expect(row?.keyChanged).toBe(1) // C → G
    expect(row?.meterChanged).toBe(0)
    expect(row?.retainedEventRatio).toBe(0)
  })

  it('writes NULL change-flags when only afterScore is present (fresh generation)', async () => {
    await recordTurn({
      requestId: 'req-fresh',
      sessionId: 'session-1',
      label: 'generate_simple',
      handler: 'generateSimple',
      model: 'claude-sonnet-4-6',
      latencyMs: 100,
      finalStatus: 'ok',
      afterScore: SCORE_A,
    })
    const row = db.select().from(orchestratorTurns).get()
    // With no before, "did the key/meter/title change?" is unanswerable
    // and must NOT be reported as a false-y "no change".
    expect(row?.keyChanged).toBeNull()
    expect(row?.meterChanged).toBeNull()
    expect(row?.titleChanged).toBeNull()
    expect(row?.measureCountAfter).toBe(1)
  })

  it('records createdAt as Unix epoch MILLISECONDS', async () => {
    const beforeMs = Date.now()
    await recordTurn({
      requestId: 'req-ts',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'compose',
      model: null,
      latencyMs: 1,
      finalStatus: 'ok',
    })
    const afterMs = Date.now()
    const row = db.select().from(orchestratorTurns).get()
    // Must be in ms range, not seconds — a sub-second turn would
    // otherwise quantize to integer seconds and break replay ordering.
    expect(row?.createdAt).toBeGreaterThanOrEqual(beforeMs)
    expect(row?.createdAt).toBeLessThanOrEqual(afterMs)
  })

  it('truncates error longer than 500 chars', async () => {
    const longErr = 'x'.repeat(900)
    await recordTurn({
      requestId: 'req-7',
      sessionId: 'session-1',
      label: 'compose',
      handler: 'dispatch',
      model: null,
      latencyMs: 1,
      finalStatus: 'error',
      error: longErr,
    })
    const row = db.select().from(orchestratorTurns).get()
    expect(row?.error?.length).toBe(500)
  })

  it('swallows DB insert failures and emits a follow-up logTurn with the error', async () => {
    // Force DB failure by pointing it at a closed/invalid DB. Easiest:
    // unset the test DB after recordTurn captured its own ref. Instead,
    // we use a malformed insert by feeding an undefined finalStatus.
    // Simpler: setDbForTesting(undefined) so getDb() reopens the real
    // default DB path — which won't have the table without a migration —
    // would interfere. We use a different strategy: monkey-patch the
    // db.insert to throw, then restore.
    const realInsert = db.insert.bind(db)
    db.insert = (() => {
      throw new Error('simulated DB failure: disk I/O')
    }) as unknown as typeof db.insert
    try {
      await expect(
        recordTurn({
          requestId: 'req-8',
          sessionId: 'session-1',
          label: 'compose',
          handler: 'compose',
          model: null,
          latencyMs: 1,
          finalStatus: 'ok',
        }),
      ).resolves.toBeUndefined()
      // Two stdout lines: the original logTurn + the recovery line.
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      const last = JSON.parse(
        logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string,
      )
      expect(last.error).toMatch(/^orchestrator_turns_insert_failed:/)
    } finally {
      db.insert = realInsert
    }
  })
})

describe('linkTurnScoreVersion — backfill after_score_version_id (SHE-18 PR1)', () => {
  let db: ReturnType<typeof makeTestDb>

  beforeEach(() => {
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    db.insert(sessions)
      .values({ id: 'session-1', userId: 'u1', createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
      .run()
    setDbForTesting(db)
  })
  afterEach(() => {
    setDbForTesting(undefined)
  })

  function seedTurn(id: string, requestId: string, createdAtMs: number): void {
    db.insert(orchestratorTurns)
      .values({
        id,
        sessionId: 'session-1',
        requestId,
        createdAt: createdAtMs,
        latencyMs: 1,
        finalStatus: 'ok',
      })
      .run()
  }

  function seedVersion(id: string): string {
    db.insert(scoreVersions)
      .values({
        id,
        sessionId: 'session-1',
        scoreJson: '{}',
        scoreHash: id,
        source: 'llm',
        createdAt: 0,
        schemaVersion: 1,
      })
      .run()
    return id
  }

  function afterOf(turnId: string): string | null {
    return (
      db
        .select({ a: orchestratorTurns.afterScoreVersionId })
        .from(orchestratorTurns)
        .where(eq(orchestratorTurns.id, turnId))
        .get()?.a ?? null
    )
  }

  it('sets after_score_version_id on the turn matching the request id', async () => {
    seedTurn('t1', 'req-1', 1000)
    const v = seedVersion('v1')
    await linkTurnScoreVersion('req-1', v, 'session-1')
    expect(afterOf('t1')).toBe('v1')
  })

  it('targets the MOST RECENT unlinked turn when a request wrote several', async () => {
    // Defensive: should a request ever record more than one turn, the
    // result-bearing one is the latest. Older turns stay unlinked.
    seedTurn('t-early', 'req-2', 1000)
    seedTurn('t-late', 'req-2', 2000)
    const v = seedVersion('v2')
    await linkTurnScoreVersion('req-2', v, 'session-1')
    expect(afterOf('t-late')).toBe('v2')
    expect(afterOf('t-early')).toBeNull()
  })

  it('does not clobber a turn that is already linked', async () => {
    seedTurn('t3', 'req-3', 1000)
    const v1 = seedVersion('v3a')
    const v2 = seedVersion('v3b')
    await linkTurnScoreVersion('req-3', v1, 'session-1')
    await linkTurnScoreVersion('req-3', v2, 'session-1') // second emit, same request
    // The already-linked latest turn is left alone (IS NULL guard); no
    // unlinked turn remains to take v2, so it's a no-op.
    expect(afterOf('t3')).toBe('v3a')
  })

  it('is a best-effort no-op when no turn matches the request id', async () => {
    const v = seedVersion('v4')
    await expect(linkTurnScoreVersion('no-such-req', v, 'session-1')).resolves.toBeUndefined()
  })

  it('will not link a turn in a DIFFERENT session even if the request id matches', async () => {
    // Defense-in-depth: request ids are server-minted UUIDs (collision-free
    // across sessions), but the explicit session predicate guarantees we
    // never write a version onto another session's turn.
    db.insert(users).values({ id: 'u2', createdAt: 0, lastSeenAt: 0 }).run()
    db.insert(sessions)
      .values({ id: 'session-2', userId: 'u2', createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
      .run()
    db.insert(orchestratorTurns)
      .values({
        id: 't-other',
        sessionId: 'session-2',
        requestId: 'shared-req',
        createdAt: 1000,
        latencyMs: 1,
        finalStatus: 'ok',
      })
      .run()
    const v = seedVersion('v5')
    // Link is scoped to session-1, but the only matching turn is in session-2.
    await linkTurnScoreVersion('shared-req', v, 'session-1')
    expect(afterOf('t-other')).toBeNull()
  })
})

describe('recordTurn — training_pairs consent capture (SHE-18 PR4)', () => {
  let db: ReturnType<typeof makeTestDb>

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '') // enable DB writes
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    db.insert(sessions)
      .values({ id: 'session-1', userId: 'u1', createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
      .run()
    setDbForTesting(db)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setDbForTesting(undefined)
    vi.unstubAllEnvs()
  })

  const okTurn = {
    requestId: 'r-cap',
    sessionId: 'session-1',
    label: 'compose' as const,
    handler: 'compose',
    model: null,
    latencyMs: 1,
    finalStatus: 'ok' as const,
  }

  it('writes NO marker when SL_CAPTURE_TRAINING is unset (self-hosted default)', async () => {
    await recordTurn(okTurn)
    expect(db.select().from(trainingPairs).all()).toHaveLength(0)
  })

  it('writes NO marker when SL_CAPTURE_TRAINING is explicitly off', async () => {
    vi.stubEnv('SL_CAPTURE_TRAINING', 'off')
    await recordTurn(okTurn)
    expect(db.select().from(trainingPairs).all()).toHaveLength(0)
  })

  it('writes a marker keyed to the turn, with an OPAQUE session hash, when on', async () => {
    vi.stubEnv('SL_CAPTURE_TRAINING', '1')
    await recordTurn(okTurn)
    const turn = db.select().from(orchestratorTurns).get()!
    const rows = db.select().from(trainingPairs).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].turnId).toBe(turn.id)
    // session id is NEVER stored raw — only a salted sha256 hex digest.
    expect(rows[0].sessionHash).not.toBe('session-1')
    expect(rows[0].sessionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].capturedAt).toBeGreaterThan(0)
  })

  it('does not capture sessionless turns (no orchestrator_turns row to mark)', async () => {
    vi.stubEnv('SL_CAPTURE_TRAINING', '1')
    await recordTurn({ ...okTurn, sessionId: undefined, finalStatus: 'fell_through' })
    expect(db.select().from(trainingPairs).all()).toHaveLength(0)
  })

  it('the session hash is stable for the same session (dedup/grouping key)', async () => {
    vi.stubEnv('SL_CAPTURE_TRAINING', '1')
    vi.stubEnv('SL_CAPTURE_SALT', 'salt-A')
    await recordTurn({ ...okTurn, requestId: 'r1' })
    await recordTurn({ ...okTurn, requestId: 'r2' })
    const hashes = db.select().from(trainingPairs).all().map((r) => r.sessionHash)
    expect(hashes).toHaveLength(2)
    expect(hashes[0]).toBe(hashes[1]) // same session → same hash
  })

  it('captures a non-ok turn too (the marker is consent, not quality — export filters)', async () => {
    vi.stubEnv('SL_CAPTURE_TRAINING', '1')
    await recordTurn({ ...okTurn, finalStatus: 'error', error: 'boom' })
    const rows = db.select().from(trainingPairs).all()
    expect(rows).toHaveLength(1)
    const turn = db.select().from(orchestratorTurns).get()!
    expect(rows[0].turnId).toBe(turn.id)
  })

  it('captureTrainingPair is idempotent on a repeated turn id (no throw, one row)', async () => {
    vi.stubEnv('SL_CAPTURE_TRAINING', '1')
    await recordTurn(okTurn) // writes the turn + one marker
    const turn = db.select().from(orchestratorTurns).get()!
    // Re-capturing the same turn (e.g. a future backfill) must be a no-op.
    expect(() => captureTrainingPair(db, { turnId: turn.id, sessionId: 'session-1' })).not.toThrow()
    expect(db.select().from(trainingPairs).all()).toHaveLength(1)
  })
})
