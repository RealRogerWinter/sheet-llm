import { randomUUID } from 'node:crypto'
import { getDb } from '@/lib/db'
import { orchestratorTurns } from '@/lib/db/schema'
import type { Score } from '@/lib/music/types'
import { DIFF_ALGO_VERSION, scoreDiff } from '@/lib/music/scoreDiff'
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
  outputTokens?: number
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
  console.log(JSON.stringify(payload))
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
    ...logFields
  } = fields
  logTurn(logFields)

  if (!sessionId || sessionId === 'anonymous') return

  // Diff is computed only when both sides are present. The function
  // itself tolerates undefined, but skipping here avoids spending the
  // hash work for the converse / refuse / fall-through paths.
  const hasDiffInputs = beforeScore !== undefined || afterScore !== undefined
  const diff = hasDiffInputs ? scoreDiff(beforeScore, afterScore) : null

  const truncatedError =
    fields.error && fields.error.length > ERROR_MAX_LEN
      ? fields.error.slice(0, ERROR_MAX_LEN)
      : fields.error

  try {
    getDb()
      .insert(orchestratorTurns)
      .values({
        id: randomUUID(),
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
        outputTokens: fields.outputTokens ?? null,
        error: truncatedError ?? null,
        replacementBlocked: fields.replacementBlocked ? 1 : 0,
      })
      .run()
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
  console.log(JSON.stringify(payload))
}
