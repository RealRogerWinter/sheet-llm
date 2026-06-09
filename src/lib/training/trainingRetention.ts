import { lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getDb } from '@/lib/db'
import { trainingPairs } from '@/lib/db/schema'
import type * as schema from '@/lib/db/schema'

type DbInstance = BetterSQLite3Database<typeof schema>

const MS_PER_DAY = 86_400_000

/**
 * SHE-18 PR6 — retention for the training-capture CONSENT MARKERS.
 *
 * Deletes `training_pairs` rows whose `captured_at` is older than `maxAgeDays`
 * (default 90, matching `trimOrchestratorTurns`). Returns the number deleted.
 * Pure function so the scheduler choice (host cron / CI) stays decoupled.
 *
 * Two retention mechanisms bound the training corpus, whichever is SHORTER:
 *   1. This TTL on the markers — trimming a marker removes its turn from the
 *      export join (the export inner-joins training_pairs), so it stops being
 *      export-eligible even though the underlying turn data may still exist.
 *   2. The cascade from `orchestrator_turns` retention (`trimOrchestratorTurns`,
 *      90d): deleting a turn drops its marker via ON DELETE CASCADE AND removes
 *      the score/prompt the export would read. So captured data is never
 *      exportable past the turn-retention horizon regardless of this knob.
 *
 * Trimming a marker does NOT delete the source-of-truth `orchestrator_turns`
 * row — markers are an independent, shorter-lived overlay.
 *
 * `captured_at` is Unix epoch MILLISECONDS (matches orchestrator_turns), so
 * the cutoff math is in ms.
 */
export function trimTrainingPairs(maxAgeDays = 90, db: DbInstance = getDb()): number {
  const cutoff = Date.now() - maxAgeDays * MS_PER_DAY
  return db.delete(trainingPairs).where(lt(trainingPairs.capturedAt, cutoff)).run().changes
}
