import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { orchestratorTurns } from '@/lib/db/schema'
import type { Score } from '@/lib/music/types'
import { DIFF_ALGO_VERSION, scoreDiff } from '@/lib/music/scoreDiff'
import { captureTrainingPair } from './trainingCapture'
import type { OrchestratorFinalStatus, TaskKind } from './types'

/** Hard upper bound on the `error` column so a runaway stack trace
 *  can't bloat the row. Matches the spec; truncation is applied at
 *  insert time so DB-side rows are bounded. */
export const ERROR_MAX_LEN = 500

/** Truncation budget for in-process error strings (e.g. the
 *  `orchestrator_turns_insert_failed: <msg>` recovery line we re-emit
 *  to stdout when the DB insert fails). Smaller than ERROR_MAX_LEN
 *  because the prefix already eats ~40 chars and the line is
 *  log-line-only (never persisted), so the budget is generous enough.
 *  Shared so the two truncation policies are explicit and adjustable
 *  in one place (PR-3 review M5). */
export const RECOVERY_ERROR_MAX_LEN = 200

/** Coerce a nullable boolean to nullable 1/0 for SQLite. NULL is
 *  preserved (and is semantically distinct from 0 — see comment at the
 *  keyChanged insert site). */
function boolToInt(b: boolean | null | undefined): number | null {
  if (b === null || b === undefined) return null
  return b ? 1 : 0
}

export interface LogTurnFields {
  requestId: string
  label: TaskKind | 'unknown'
  handler: string
  model: string | null
  latencyMs: number
  confidence?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
  /** Raw Anthropic API cost for the whole turn, micro-USD (1e-6 USD). */
  costMicroUsd?: number
  opValidationErrors?: number
  finalStatus: OrchestratorFinalStatus
  error?: string
  /**
   * Multi-staff telemetry — emitted when the produced/edited score has
   * non-trivial layout so we can track adoption + regressions per
   * handler. Flat keys (not a nested object/array) so downstream log
   * parsers without nested-JSON support keep working.
   */
  staffCount?: 1 | 2
  voiceCountStaff0?: number
  voiceCountStaff1?: number
  /** Count of (staffIdx, voiceIdx) bound violations during this turn's
   *  ops. Bumped by transformScore via assertVoiceExists; surfaced so
   *  we can tell when the LLM mis-targets in the wild. */
  voiceOpFailures?: number
  /**
   * Lever B telemetry — emitted by `runCompose` when the sub-classifier
   * dispatch flag is on. `'patch'` means the request was routed to
   * editIntraMeasure; `'regen'` means it stayed on the render_score
   * path; `'skipped'` means the dispatch didn't run (no editedScore, or
   * the flag was off). Production signal for measuring Lever B's
   * effect on verbose-regen rates.
   */
  composePatchDispatch?:
    | 'patch'
    | 'regen'
    | 'skipped'
    // M3.5-PR-3 — broadened semantics: when the new tool dispatch path
    // runs, the picked tool name is recorded here. The DB column is
    // a free-form text() so the schema accepts any string; we keep the
    // union closed in TS for clarity.
    | 'extend_composition'
    | 'insert_measures'
    | 'region_replace'
    | 'edit_intra_measure'
    | 'regenerate_all'
  /**
   * M3.5-PR-4 — replacement-as-confirmation gate telemetry. When true,
   * the orchestrator marked the turn as `requiresConfirmation` and the
   * route surfaced a modal to the user. Persisted to
   * `orchestrator_turns.replacement_blocked` so we can grade gate
   * noise vs. real-replacement frequency.
   */
  replacementBlocked?: boolean
  /**
   * M26 follow-up — the resolved product/paywall tier this turn ran under
   * (`free` = bounded ≤4-bar; `pro` = full). Stdout-only (not persisted to a
   * DB column) so the turn logs show which tier served each request — e.g.
   * to spot an unbounded pro compose vs a bounded free edit.
   */
  generationTier?: 'free' | 'pro'
}

/**
 * SHE-8 never-log invariant — strip anything that looks like a provider API key
 * from a string before it is logged or persisted. The BYOK seam plumbs a
 * client-supplied `debug.apiKey` into provider calls; this is the defence so a
 * key can NEVER surface in the orchestrator turn log or the `error` column, even
 * if a future field (or an upstream provider error message) carries one. Covers
 * Anthropic (`sk-ant-…`), OpenAI (`sk-…`/`sk-proj-…`), and Groq (`gsk_…`) shapes.
 */
const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]{6,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,})/g
export function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, '[redacted]')
}

/**
 * Structured one-line JSON log per orchestrator turn. Captured by
 * Vercel/Node stdout. Intentionally minimal — no transport, no
 * external observability vendor. Test runs silence output via
 * ORCHESTRATOR_LOG_SILENT=1.
 */
export function logTurn(fields: LogTurnFields): void {
  if (process.env.ORCHESTRATOR_LOG_SILENT === '1') return
  const payload = {
    evt: 'orchestrator.turn',
    ts: new Date().toISOString(),
    ...fields,
  }
  // Redact the FULL serialized line so the never-log invariant holds for every
  // field (incl. `error` and any future addition), not just known ones.
  console.log(redactSecrets(JSON.stringify(payload)))
}

/**
 * Persistent variant of {@link logTurn}. In addition to emitting the
 * stdout line, this also inserts a row into `orchestrator_turns` so
 * the forensic trail survives process restart and Vercel log
 * rotation. Best-effort: any DB failure is swallowed and re-surfaced
 * as a `logTurn` line with `error: 'orchestrator_turns_insert_failed: ...'`,
 * never propagated to the caller.
 *
 * Skip rules:
 * - `ORCHESTRATOR_LOG_SILENT=1` → skip BOTH stdout and DB (test mode)
 * - `sessionId` missing or 'anonymous' → emit stdout but skip DB
 *   (sessions table requires a real FK; anonymous chats don't have one)
 */
export interface RecordTurnFields extends LogTurnFields {
  sessionId?: string
  messageId?: string
  beforeScoreVersionId?: string
  afterScoreVersionId?: string
  beforeScore?: Score
  afterScore?: Score
  /** Count of ops applied by an edit handler. NULL/omitted for
   *  non-edit handlers. */
  appliedOpsCount?: number
  // SHE-18 PR3 — quality detail. All optional; omitted (=> NULL) for turns
  // with no before-score (compose/converse/refuse) or when the gate path
  // didn't run. See the column comments in schema.ts.
  /** verifyAllOriginalsPreserved: did every claimed-retained measure survive. */
  preservationOk?: boolean
  /** Number of claimed-retained measures whose hash diverged. */
  preservationMismatchCount?: number
  /** detectReplacement.retainedIdentityRatio ∈ [0,1] (computed every edit turn). */
  replacementRetainedIdentityRatio?: number
  /** detectReplacement.reasons — persisted as a JSON array string. */
  replacementReasons?: string[]
  /** detectReplacement.userExplicitRewrite — user/dispatch asked to start over. */
  replacementUserExplicitRewrite?: boolean
}

export async function recordTurn(fields: RecordTurnFields): Promise<void> {
  if (process.env.ORCHESTRATOR_LOG_SILENT === '1') return

  // Always emit the stdout line first — even if the DB insert fails
  // we still want the immediate operational signal.
  const {
    sessionId,
    messageId,
    beforeScoreVersionId,
    afterScoreVersionId,
    beforeScore,
    afterScore,
    appliedOpsCount,
    preservationOk,
    preservationMismatchCount,
    replacementRetainedIdentityRatio,
    replacementReasons,
    replacementUserExplicitRewrite,
    ...logFields
  } = fields
  logTurn(logFields)

  if (!sessionId || sessionId === 'anonymous') return

  // Diff is computed only when both sides are present. The function
  // itself tolerates undefined, but skipping here avoids spending the
  // hash work for the converse / refuse / fall-through paths.
  const hasDiffInputs = beforeScore !== undefined || afterScore !== undefined
  const diff = hasDiffInputs ? scoreDiff(beforeScore, afterScore) : null

  // Redact before truncate so a key can't survive into the persisted column.
  const redactedError = fields.error ? redactSecrets(fields.error) : fields.error
  const truncatedError =
    redactedError && redactedError.length > ERROR_MAX_LEN
      ? redactedError.slice(0, ERROR_MAX_LEN)
      : redactedError

  const turnId = randomUUID()
  const db = getDb()
  try {
    db
      .insert(orchestratorTurns)
      .values({
        id: turnId,
        sessionId,
        messageId: messageId ?? null,
        requestId: fields.requestId,
        // Unix epoch MILLISECONDS — orchestrator_turns.created_at is
        // intentionally ms-resolution (unlike other tables) so multiple
        // turns within the same wall-second can be ordered
        // deterministically by replay tooling.
        createdAt: Date.now(),
        latencyMs: fields.latencyMs,
        finalStatus: fields.finalStatus,
        classificationKind: fields.label ?? null,
        classificationConfidence: fields.confidence ?? null,
        handler: fields.handler ?? null,
        handlerModel: fields.model ?? null,
        composePatchDispatch: fields.composePatchDispatch ?? null,
        beforeScoreVersionId: beforeScoreVersionId ?? null,
        afterScoreVersionId: afterScoreVersionId ?? null,
        diffAlgoVersion: DIFF_ALGO_VERSION,
        measureCountBefore: diff?.measureCountBefore ?? null,
        measureCountAfter: diff?.measureCountAfter ?? null,
        voiceCountBefore: diff?.voiceCountBefore ?? null,
        voiceCountAfter: diff?.voiceCountAfter ?? null,
        // boolean → 1/0; null (one-sided diff) → SQL NULL. We must NOT
        // write 0 when the comparison was meaningless — that would
        // falsely report "key/meter/title was preserved" for fresh
        // generations from no prior score.
        keyChanged: boolToInt(diff?.keyChanged ?? null),
        meterChanged: boolToInt(diff?.meterChanged ?? null),
        titleChanged: boolToInt(diff?.titleChanged ?? null),
        retainedEventRatio: diff?.retainedEventRatio ?? null,
        appliedOpsCount: appliedOpsCount ?? null,
        inputTokens: fields.inputTokens ?? null,
        cachedInputTokens: fields.cachedInputTokens ?? null,
        cacheCreationInputTokens: fields.cacheCreationInputTokens ?? null,
        outputTokens: fields.outputTokens ?? null,
        costMicroUsd: fields.costMicroUsd ?? null,
        error: truncatedError ?? null,
        replacementBlocked: fields.replacementBlocked ? 1 : 0,
        // SHE-18 PR3 — quality detail. boolToInt preserves NULL (not-computed)
        // vs 0 (computed-false); reasons serialize to a JSON array string.
        preservationOk: boolToInt(preservationOk ?? null),
        preservationMismatchCount: preservationMismatchCount ?? null,
        replacementRetainedIdentityRatio: replacementRetainedIdentityRatio ?? null,
        replacementReasons: replacementReasons ? JSON.stringify(replacementReasons) : null,
        replacementUserExplicitRewrite: boolToInt(replacementUserExplicitRewrite ?? null),
      })
      .run()
    // SHE-18 PR4 — mark this turn for the training corpus IF hosted capture is
    // on (SL_CAPTURE_TRAINING). Self-hosted installs (flag off) never write a
    // marker. Deliberately INSIDE the try, right after the turn insert's .run()
    // autocommits (better-sqlite3 is synchronous), so it only marks turns that
    // actually persisted and the turn_id FK is satisfiable. captureTrainingPair
    // self-swallows, so it cannot throw into the outer catch and mislabel a
    // capture failure as a turn-insert failure.
    captureTrainingPair(db, { turnId, sessionId })
  } catch (e) {
    // Observability must never break the caller. Re-emit as a stdout
    // line so the failure itself isn't lost.
    const msg = e instanceof Error ? e.message : String(e)
    logTurn({
      ...logFields,
      error: `orchestrator_turns_insert_failed: ${msg.slice(0, RECOVERY_ERROR_MAX_LEN)}`,
    })
  }
}

export interface TurnUsage {
  inputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
  /** Raw Anthropic cost for the whole turn, micro-USD. */
  costMicroUsd?: number
}

/**
 * Backfill the token / cost columns on an already-recorded turn. STREAMING
 * outcomes (converse / sectional) record their turn at dispatch with only the
 * IN-run() cost so far (the classifier, and the Sonnet dispatcher on the
 * converse path) — the streamed generation itself runs later, in the route's
 * pump, outside `run()`'s meter scope. The route wraps the pump in its own meter
 * scope and calls this on `message-stop` / `done` with the STREAMED usage.
 *
 * ADDITIVE: it SUMS the streamed usage into the columns rather than overwriting,
 * so the pre-call (classifier/dispatcher) cost already on the row is preserved —
 * the total is classifier + dispatcher + streamed generation, the true turn cost
 * the paywall will settle against. Matches on request_id (one turn per streaming
 * request); best-effort — a failure never breaks the stream.
 */
export function updateTurnUsageByRequestId(
  requestId: string,
  usage: TurnUsage,
  db: ReturnType<typeof getDb> = getDb(),
): void {
  try {
    // ADD (not overwrite): COALESCE(col,0) + delta, so the in-run() pre-call
    // cost already on the row is preserved.
    db
      .update(orchestratorTurns)
      .set({
        inputTokens: sql`COALESCE(${orchestratorTurns.inputTokens}, 0) + ${usage.inputTokens ?? 0}`,
        cachedInputTokens: sql`COALESCE(${orchestratorTurns.cachedInputTokens}, 0) + ${usage.cachedInputTokens ?? 0}`,
        cacheCreationInputTokens: sql`COALESCE(${orchestratorTurns.cacheCreationInputTokens}, 0) + ${usage.cacheCreationInputTokens ?? 0}`,
        outputTokens: sql`COALESCE(${orchestratorTurns.outputTokens}, 0) + ${usage.outputTokens ?? 0}`,
        costMicroUsd: sql`COALESCE(${orchestratorTurns.costMicroUsd}, 0) + ${usage.costMicroUsd ?? 0}`,
      })
      .where(eq(orchestratorTurns.requestId, requestId))
      .run()
  } catch (e) {
    // Observability must never break the stream.
    console.warn('[orchestrator] turn usage backfill failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/** The persisted turn cost the paywall settles a NON-STREAMING turn against. */
export interface TurnCostRow {
  /** Raw Anthropic cost for the whole turn (µUSD). NULL when recordTurn never
   *  wrote it (a DB miss / skip) — the caller fails closed (NULL ≠ free). */
  costMicroUsd: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheCreationInputTokens: number | null
  outputTokens: number | null
  handlerModel: string | null
  finalStatus: OrchestratorFinalStatus
}

/**
 * Read the orchestrator_turns row the paywall settles against, by request id.
 * A NON-STREAMING request writes exactly one turn (recordTurnForResult); the
 * `orchestrator_turns_request` index (migration 0013) backs this lookup. When
 * more than one row somehow shares the id, the most recent wins. Returns
 * undefined when no row exists OR on any DB error, so the caller treats an
 * unreadable cost as fail-closed rather than as a $0 turn.
 */
export function readTurnCostByRequestId(
  requestId: string,
  db: ReturnType<typeof getDb> = getDb(),
): TurnCostRow | undefined {
  try {
    const row = db
      .select({
        costMicroUsd: orchestratorTurns.costMicroUsd,
        inputTokens: orchestratorTurns.inputTokens,
        cachedInputTokens: orchestratorTurns.cachedInputTokens,
        cacheCreationInputTokens: orchestratorTurns.cacheCreationInputTokens,
        outputTokens: orchestratorTurns.outputTokens,
        handlerModel: orchestratorTurns.handlerModel,
        finalStatus: orchestratorTurns.finalStatus,
      })
      .from(orchestratorTurns)
      .where(eq(orchestratorTurns.requestId, requestId))
      .orderBy(desc(orchestratorTurns.createdAt))
      .limit(1)
      .get()
    if (!row) return undefined
    return { ...row, finalStatus: row.finalStatus as OrchestratorFinalStatus }
  } catch (e) {
    console.warn('[orchestrator] turn cost read failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    })
    return undefined
  }
}

/**
 * SHE-18 PR1 — link an orchestrator turn to the score version it emitted,
 * keyed by request id.
 *
 * `recordTurn` runs INSIDE `run()`, but the `score_versions` row for the
 * emitted score isn't minted until `appendMessages` in the responder, AFTER
 * `run()` returns — so the turn is always written with
 * `after_score_version_id = NULL` and the id can only be back-filled here.
 * The responder is the first place both the request id (which keyed the
 * turn) and the freshly-minted version id are in scope.
 *
 * Scoped to (sessionId, requestId): in practice a request writes exactly one
 * turn row (the cost backfill is an UPDATE of that same row, not a second
 * INSERT), so this resolves to that row. The `sessionId` predicate makes the
 * partition explicit rather than relying on the request-id→session invariant,
 * and we still take the MOST RECENT still-unlinked turn defensively, should a
 * request ever record more than one. The `IS NULL` guard makes a second emit
 * under the same request id a no-op on the already-linked turn rather than
 * clobbering it. Best-effort: a telemetry write must never break delivery, so
 * DB errors are swallowed (mirrors `recordTurn`).
 */
export async function linkTurnScoreVersion(
  requestId: string,
  afterScoreVersionId: string,
  sessionId: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<void> {
  try {
    // better-sqlite3 is synchronous; resolve the target id first (most-recent
    // unlinked turn for this session+request), then update by primary key so
    // we touch exactly one row. createdAt is ms-resolution; the secondary
    // desc(id) pins the tiebreak when two turns share a millisecond.
    const target = db
      .select({ id: orchestratorTurns.id })
      .from(orchestratorTurns)
      .where(
        and(
          eq(orchestratorTurns.sessionId, sessionId),
          eq(orchestratorTurns.requestId, requestId),
          isNull(orchestratorTurns.afterScoreVersionId),
        ),
      )
      .orderBy(desc(orchestratorTurns.createdAt), desc(orchestratorTurns.id))
      .limit(1)
      .get()
    if (!target) return
    db.update(orchestratorTurns)
      .set({ afterScoreVersionId })
      .where(eq(orchestratorTurns.id, target.id))
      .run()
  } catch (e) {
    console.warn('[orchestrator] link turn score version failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

export interface LogShadowDivergenceFields {
  requestId: string
  label: TaskKind | 'unknown'
  /** True when the orchestrator would have served a different result than legacy did. */
  diverged: boolean
  /** Reason summary: e.g. 'different_key', 'different_measure_count', 'orchestrator_refused'. */
  reason?: string
  latencyMsOrchestrator?: number
  latencyMsLegacy?: number
}

/**
 * Emitted in shadow mode after both paths have run. Used to gauge
 * orchestrator readiness before flipping ORCHESTRATOR_ENABLED on.
 */
export function logShadowDivergence(fields: LogShadowDivergenceFields): void {
  if (process.env.ORCHESTRATOR_LOG_SILENT === '1') return
  const payload = {
    evt: 'orchestrator.shadow_divergence',
    ts: new Date().toISOString(),
    ...fields,
  }
  console.log(redactSecrets(JSON.stringify(payload)))
}
