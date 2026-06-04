/**
 * Backfill historical `orchestrator_turns` rows from pre-existing
 * `messages` and `score_versions` data (M3.5-PR-7).
 *
 * Why: PR-1 introduced `orchestrator_turns` for forward-going forensic
 * replay. Sessions that existed BEFORE the table was added carry no
 * turn rows, so `npm run replay --session <id>` is empty for them.
 * This script synthesizes a best-effort turn per assistant message so
 * historical replay returns at least a coarse decision trail. Inputs
 * we never recorded (classification kind, dispatcher choice, latency)
 * stay null / 'unknown' — the column nullability accommodates this.
 *
 * Usage:
 *   pnpm backfill:orchestrator-turns
 *
 * Idempotency: each backfilled row is keyed by message id via a
 * synthetic `request_id` (`backfill_<message_id>`). Re-running the
 * script issues `INSERT … WHERE NOT EXISTS` semantics by checking for
 * an existing turn that already references the message — this means
 * messages whose turn was recorded LIVE (via `recordTurn`) are never
 * double-counted, and re-runs are idempotent.
 *
 * Output: a one-line summary
 *   "backfill: scanned=N rows-inserted=M rows-skipped=K"
 */
import { randomUUID } from 'node:crypto'
import { eq, inArray, isNotNull } from 'drizzle-orm'
import { ensureMigrationsApplied, getDb } from '@/lib/db'
import {
  messages as messagesTable,
  orchestratorTurns,
  scoreVersions,
} from '@/lib/db/schema'

interface BackfillResult {
  scanned: number
  inserted: number
  skipped: number
}

export function backfillOrchestratorTurns(
  db = getDb(),
): BackfillResult {
  // Apply pending migrations first. Mirrors scripts/replay.ts — a
  // fresh checkout's DB may not have the orchestrator_turns table yet.
  ensureMigrationsApplied(db)

  // All assistant messages in the system. We DO NOT filter by
  // session here because some legacy sessions may have been deleted
  // (soft-deleted via deleted_at, but the messages row may still be
  // intact). The FK to sessions(id) is ON DELETE CASCADE — if the
  // session is truly gone, the insert fails and we count it as
  // skipped. The session-id-fanout-then-insert pattern would also
  // work but is dominated by the insert cost; we keep this simple.
  const assistantMessages = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.role, 'assistant'))
    .all()

  // Index the existing turns by message_id so we can detect "already
  // covered" in O(1). NULL message_ids are dropped (those are
  // refuse / fall-through rows; they cannot be a backfill duplicate
  // since backfill keys every row to a message).
  const existingTurnsByMessageId = new Set<string>()
  const existingRows = db
    .select({ messageId: orchestratorTurns.messageId })
    .from(orchestratorTurns)
    .where(isNotNull(orchestratorTurns.messageId))
    .all()
  for (const r of existingRows) {
    if (r.messageId) existingTurnsByMessageId.add(r.messageId)
  }

  // Pre-fetch score_versions linked to any candidate message. This
  // avoids a per-message point query inside the loop.
  const candidateMessageIds = assistantMessages
    .filter((m) => !existingTurnsByMessageId.has(m.id))
    .map((m) => m.id)
  if (candidateMessageIds.length === 0) {
    return { scanned: assistantMessages.length, inserted: 0, skipped: assistantMessages.length }
  }

  // For each candidate assistant message, find its `after` score
  // version (the one the message itself produced — joined via
  // score_versions.message_id) and the `before` (the version's parent).
  //
  // Bounded scan: rather than slurping the whole score_versions table
  // into memory (OOM risk on production-sized DBs), restrict the query
  // to the set of session ids that actually carry assistant messages.
  // The before/after lookup only walks parent chains WITHIN a session,
  // so any score_version outside this set is provably irrelevant.
  const distinctSessionIds = Array.from(
    new Set(assistantMessages.map((m) => m.sessionId)),
  )
  if (distinctSessionIds.length === 0) {
    return { scanned: assistantMessages.length, inserted: 0, skipped: assistantMessages.length }
  }
  const versionRows = db
    .select()
    .from(scoreVersions)
    .where(inArray(scoreVersions.sessionId, distinctSessionIds))
    .all()
  const versionsByMessageId = new Map<string, typeof versionRows[number]>()
  const versionsById = new Map<string, typeof versionRows[number]>()
  for (const v of versionRows) {
    versionsById.set(v.id, v)
    if (v.messageId) versionsByMessageId.set(v.messageId, v)
  }

  let inserted = 0
  let skipped = 0
  let seq = 0
  for (const msg of assistantMessages) {
    if (existingTurnsByMessageId.has(msg.id)) {
      skipped++
      continue
    }
    seq++
    const afterVersion = versionsByMessageId.get(msg.id)
    const beforeVersion = afterVersion?.parentVersionId
      ? versionsById.get(afterVersion.parentVersionId)
      : undefined

    // messages.created_at is Unix epoch SECONDS;
    // orchestrator_turns.created_at is MILLISECONDS. Upconvert.
    const createdAtMs = msg.createdAt * 1000
    const requestId = `backfill_${msg.sessionId}_${seq}_${createdAtMs}`

    const finalStatus = msg.streamStatus === 'errored' ? 'error' : 'ok'

    try {
      db.insert(orchestratorTurns)
        .values({
          id: randomUUID(),
          sessionId: msg.sessionId,
          messageId: msg.id,
          requestId,
          createdAt: createdAtMs,
          latencyMs: 0,
          finalStatus,
          // Unknown — we never recorded the classification or handler
          // at the time. NULL would be cleaner but classificationKind
          // is the readable signal in replay output; the literal
          // 'unknown' makes the backfilled rows obvious there.
          classificationKind: 'unknown',
          classificationConfidence: null,
          handler: 'unknown',
          handlerModel: null,
          composePatchDispatch: null,
          beforeScoreVersionId: beforeVersion?.id ?? null,
          afterScoreVersionId: afterVersion?.id ?? null,
          // diff_algo_version has a default; pass through explicitly
          // so the column comment stays accurate for backfilled rows.
          diffAlgoVersion: 1,
          measureCountBefore: null,
          measureCountAfter: null,
          voiceCountBefore: null,
          voiceCountAfter: null,
          keyChanged: null,
          meterChanged: null,
          titleChanged: null,
          retainedEventRatio: null,
          appliedOpsCount: null,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          error: msg.errorCode ?? null,
          replacementBlocked: 0,
        })
        .run()
      inserted++
    } catch {
      // FK violation (session deleted) or any other DB error — count
      // as skipped, don't propagate. Backfill is best-effort.
      skipped++
    }
  }

  return { scanned: assistantMessages.length, inserted, skipped }
}

// CLI entry point. We don't gate on `import.meta` because tsx runs
// this file as the entry — but we DO want unit tests to import the
// function without firing the side-effects, so the entry guard
// checks `process.argv[1]` against the resolved script path.
async function main() {
  const result = backfillOrchestratorTurns()
  console.log(
    `backfill: scanned=${result.scanned} rows-inserted=${result.inserted} rows-skipped=${result.skipped}`,
  )
}

// Idiomatic Node "is this the entry?" check that works under tsx.
const isEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('backfill-orchestrator-turns.ts') ||
    process.argv[1].endsWith('backfill-orchestrator-turns.js'))
if (isEntry) {
  main().catch((e) => {
    console.error('[backfill] error:', e)
    process.exit(1)
  })
}
