import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'

/**
 * How long an orphan user-only session is allowed to sit before
 * reapOrphanSessions soft-deletes it. Long enough to cover a slow
 * retry by the user (they reload, see their prompt, type again) and
 * a re-mount of the recovery-boot path; short enough that
 * accumulated orphans don't pollute the sidebar listing.
 */
const ORPHAN_SESSION_MAX_AGE_SEC = 30 * 60 // 30 min

// Auth GC retention (PR-9). Dead rows are kept this long for audit/debugging,
// then hard-deleted. Tokens are single-use + short-TTL so a week is ample;
// sessions are revoke-for-audit so a month before GC.
const AUTH_TOKEN_RETENTION_SEC = 7 * 24 * 60 * 60 // 7 days
const AUTH_SESSION_RETENTION_SEC = 30 * 24 * 60 * 60 // 30 days

/** better-sqlite3 RunResult → affected row count (0 if shape is unexpected). */
function runChanges(result: unknown): number {
  return typeof result === 'object' && result !== null && 'changes' in result
    ? Number((result as { changes: number }).changes)
    : 0
}

/**
 * Mark abandoned `partial` streaming-message rows as `errored` so the
 * client renders them as failed turns instead of phantom missing
 * responses.
 *
 * Driven by the existing `messages_streaming` partial index
 * (`WHERE stream_status='partial'`), so the scan is cheap even on
 * tables with millions of `complete` rows.
 *
 * Race-safe alongside `finalizeStreamingMessage`: the finalize path's
 * `WHERE stream_status='partial'` guard means whichever side flips the
 * row first wins. If the reaper marks a row `errored` at t=9:55 and
 * the stream legitimately finishes at t=10:01, the finalize returns
 * `{updated:false}` and logs — the row stays `errored` (which is the
 * correct user-facing state, since from any proxy's POV the stream
 * timed out).
 *
 * Idempotent. Sync (better-sqlite3 driver). Returns `{reaped}` for
 * logging.
 */
export function reapStalePartials(
  db = getDb(),
  olderThanSec = 600,
): { reaped: number } {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec
  const result = db.run(sql`
    UPDATE messages
    SET stream_status = 'errored', error_code = 'stale_partial'
    WHERE stream_status = 'partial' AND created_at < ${cutoff}
  `)
  // better-sqlite3 returns RunResult with `changes` as the affected row count.
  return { reaped: runChanges(result) }
}

/**
 * Soft-delete sessions whose ONLY message is a single user row older
 * than `olderThanSec`. These accrue from the early-persist contract
 * in `src/app/api/chat/route.ts`: the user turn is written before
 * the LLM call so a failure-then-reload can recover the prompt, but
 * if the user never retries (closes the tab, gives up) the session
 * row + its lone user message sit forever as a sidebar-poisoning
 * orphan. Soft-delete (set `deleted_at`) rather than hard-delete so
 * fork descendants can still resolve their `forked_from_session_id`
 * back-reference if any happen to point here.
 *
 * The "exactly one user message, no assistant" predicate is the
 * load-bearing one — a session with [user, assistant] is a normal
 * completed turn even if it's old; only a stuck user-alone session
 * is reapable. We bound the scan by `last_message_at` so the WHERE
 * uses the `sessions_user_activity` index instead of a full scan.
 *
 * Idempotent: deleted sessions are skipped via `deleted_at IS NULL`.
 * Returns `{reaped}` for logging.
 */
export function reapOrphanSessions(
  db = getDb(),
  olderThanSec = ORPHAN_SESSION_MAX_AGE_SEC,
): { reaped: number } {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec
  // The correlated subquery is bounded to messages of THIS session only,
  // so the cost is O(rows-per-session) — tiny in practice. The outer
  // WHERE narrows the session set to inactive, undeleted ones first.
  const result = db.run(sql`
    UPDATE sessions
    SET deleted_at = ${Math.floor(Date.now() / 1000)}
    WHERE deleted_at IS NULL
      AND last_message_at < ${cutoff}
      AND (
        SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id
      ) = 1
      AND (
        SELECT role FROM messages WHERE messages.session_id = sessions.id LIMIT 1
      ) = 'user'
  `)
  return { reaped: runChanges(result) }
}

/**
 * Hard-delete DEAD auth_tokens — consumed or expired — past the retention
 * window. Tokens are single-use + short-TTL (24h verify / 60min reset), so a
 * row older than the window is certainly dead; we keep it a few days for audit
 * then GC. Idempotent. Sync (better-sqlite3). Returns `{reaped}`.
 */
export function reapExpiredAuthTokens(
  db = getDb(),
  retentionSec = AUTH_TOKEN_RETENTION_SEC,
): { reaped: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionSec
  const result = db.run(sql`
    DELETE FROM auth_tokens
    WHERE (consumed_at IS NOT NULL AND consumed_at < ${cutoff})
       OR (expires_at < ${cutoff})
  `)
  return { reaped: runChanges(result) }
}

/**
 * Hard-delete DEAD auth_sessions past the retention window. A session is dead
 * the same three ways `verifyAuthSession` deems it un-authenticatable: REVOKED,
 * ABSOLUTELY-expired, or IDLE-expired (a never-revoked remember-me session can
 * go idle-dead at +14d while its absolute expiry is +90d — it must still be
 * reaped, not linger). Logout/reset/rotation revoke (not delete) to keep the
 * audit row; the janitor GCs it here once it's been dead for the retention
 * window. A LIVE session is never touched. Idempotent. Sync. Returns `{reaped}`.
 */
export function reapExpiredAuthSessions(
  db = getDb(),
  retentionSec = AUTH_SESSION_RETENTION_SEC,
): { reaped: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionSec
  const result = db.run(sql`
    DELETE FROM auth_sessions
    WHERE (revoked_at IS NOT NULL AND revoked_at < ${cutoff})
       OR (expires_at < ${cutoff})
       OR (idle_expires_at < ${cutoff})
  `)
  return { reaped: runChanges(result) }
}

// Daily-quota retention (hosted abuse-gating layer). Anonymous 'a:' rows hold a
// hashed/truncated IP — short-lived PII — so they're reaped once their window
// has fully CLOSED plus a small grace (so a live or just-closed window is never
// deleted out from under an active limit). The cutoff uses the SAME
// SL_DAILY_QUOTA_WINDOW_SEC the counting side (dailyQuota.ts) uses, read here
// directly to avoid an orchestrator→db import; a longer configured window only
// makes the reaper MORE conservative. window_start is indexed, so the scan is
// bounded. 'u:' rows are erased on account deletion via FK cascade; this reaper
// covers anon rows + any abandoned 'u:'/'*' rows.
const QUOTA_WINDOW_DEFAULT_SEC = 24 * 60 * 60 // mirror dailyQuota default
const QUOTA_RETENTION_GRACE_DEFAULT_SEC = 60 * 60
function quotaIntEnv(name: string, def: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : def
}

/**
 * Hard-delete fully-expired request_quota rows past the window+grace cutoff.
 * Idempotent. Sync (better-sqlite3). Returns `{reaped}`. No-op on an empty table.
 */
export function reapExpiredQuotaCounters(db = getDb()): { reaped: number } {
  const win = quotaIntEnv('SL_DAILY_QUOTA_WINDOW_SEC', QUOTA_WINDOW_DEFAULT_SEC)
  const grace = quotaIntEnv('SL_DAILY_QUOTA_RETENTION_GRACE_SEC', QUOTA_RETENTION_GRACE_DEFAULT_SEC)
  const cutoff = Math.floor(Date.now() / 1000) - win - grace
  const result = db.run(sql`DELETE FROM request_quota WHERE window_start < ${cutoff}`)
  return { reaped: runChanges(result) }
}
