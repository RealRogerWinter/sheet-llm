import { lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getDb } from './index'
import { orchestratorTurns } from './schema'
import type * as schema from './schema'

type DbInstance = BetterSQLite3Database<typeof schema>

/**
 * Delete `orchestrator_turns` rows older than `maxAgeDays` (default 90).
 * Returns the number of rows deleted.
 *
 * Intended to be called on a daily schedule. Not wired to a cron yet —
 * M3.5 PR-7 will register a scheduled trigger. Exposed as a pure
 * function so the scheduler choice (Vercel cron / GH Actions / etc.)
 * stays decoupled from the retention logic.
 *
 * The 90-day default matches the `pre_migration_score_json` sidecar
 * retention in `migrateScores.ts` — both are forensic-only data with
 * the same operator-visibility horizon.
 *
 * Note: `orchestrator_turns.created_at` is Unix epoch MILLISECONDS
 * (unlike most other tables which store seconds), so the cutoff math
 * here uses ms. See the schema comment on the column for rationale.
 */
const MS_PER_DAY = 86_400_000
export function trimOrchestratorTurns(maxAgeDays = 90, db: DbInstance = getDb()): number {
  const cutoff = Date.now() - maxAgeDays * MS_PER_DAY
  const result = db.delete(orchestratorTurns).where(lt(orchestratorTurns.createdAt, cutoff)).run()
  return result.changes
}
