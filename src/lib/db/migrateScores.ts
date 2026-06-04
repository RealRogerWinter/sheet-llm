import { eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  CURRENT_SCORE_SCHEMA_VERSION,
  migrateScoreToV1,
  rollbackScoreFromSidecar,
} from '../music/migrateScoreV1'
import { scoreVersions } from './schema'

/**
 * Database type alias narrowed to the tables we touch. We use a
 * generic over the full Drizzle DB so callers can pass either the
 * better-sqlite3 production DB or an in-memory test DB.
 */
type DB = BetterSQLite3Database<Record<string, unknown>>

/**
 * Lazily migrate a single score_version row to the current schema
 * version. Idempotent: returns immediately if the row is already
 * at CURRENT_SCORE_SCHEMA_VERSION.
 *
 * On migration: stores the pre-migration score_json in the
 * `pre_migration_score_json` sidecar so `rollbackScoreVersionToV0`
 * can restore it if needed. Bumps schema_version.
 */
export async function migrateScoreVersionRow(db: DB, id: string): Promise<{
  migrated: boolean
  reason: 'already-current' | 'no-changes' | 'migrated' | 'not-found'
}> {
  const rows = await db
    .select()
    .from(scoreVersions)
    .where(eq(scoreVersions.id, id))
    .limit(1)

  if (rows.length === 0) return { migrated: false, reason: 'not-found' }
  const row = rows[0]

  if (row.schemaVersion >= CURRENT_SCORE_SCHEMA_VERSION) {
    return { migrated: false, reason: 'already-current' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(row.scoreJson)
  } catch {
    // Malformed JSON — mark as current to skip re-tries, but don't
    // overwrite the existing scoreJson. Sidecar stays null.
    await db
      .update(scoreVersions)
      .set({ schemaVersion: CURRENT_SCORE_SCHEMA_VERSION })
      .where(eq(scoreVersions.id, id))
    return { migrated: false, reason: 'no-changes' }
  }

  const result = migrateScoreToV1(raw)

  if (!result.changed) {
    // Nothing to alter — just bump the version so future calls skip.
    await db
      .update(scoreVersions)
      .set({ schemaVersion: CURRENT_SCORE_SCHEMA_VERSION })
      .where(eq(scoreVersions.id, id))
    return { migrated: false, reason: 'no-changes' }
  }

  await db
    .update(scoreVersions)
    .set({
      scoreJson: JSON.stringify(result.migrated),
      preMigrationScoreJson: JSON.stringify(result.original),
      schemaVersion: CURRENT_SCORE_SCHEMA_VERSION,
    })
    .where(eq(scoreVersions.id, id))

  return { migrated: true, reason: 'migrated' }
}

/**
 * Batch-migrate every score_version row that's below the current
 * schema version. Walks in chunks so a malformed row's exception
 * doesn't abort the whole sweep.
 *
 * Returns counts of (visited, migrated, skipped, errored) for
 * deploy-time observability.
 */
export async function migrateAllPhase1(db: DB): Promise<{
  visited: number
  migrated: number
  skipped: number
  errored: number
}> {
  const counts = { visited: 0, migrated: 0, skipped: 0, errored: 0 }

  const stale = await db
    .select({ id: scoreVersions.id })
    .from(scoreVersions)
    .where(lt(scoreVersions.schemaVersion, CURRENT_SCORE_SCHEMA_VERSION))

  for (const { id } of stale) {
    counts.visited++
    try {
      const r = await migrateScoreVersionRow(db, id)
      if (r.migrated) counts.migrated++
      else counts.skipped++
    } catch {
      counts.errored++
    }
  }

  return counts
}

/**
 * Restore a score_version to its pre-Phase-1 form using the sidecar
 * pre_migration_score_json. Used for incident response when a defect
 * in the migration is discovered.
 *
 * Returns true on success, false when:
 *  - the row doesn't exist
 *  - the sidecar is null (was already trimmed or never populated)
 *  - the sidecar contains malformed JSON
 */
export async function rollbackScoreVersionToV0(db: DB, id: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(scoreVersions)
    .where(eq(scoreVersions.id, id))
    .limit(1)

  if (rows.length === 0) return false
  const row = rows[0]

  const restored = rollbackScoreFromSidecar(row.preMigrationScoreJson)
  if (restored === null) return false

  await db
    .update(scoreVersions)
    .set({
      scoreJson: JSON.stringify(restored),
      preMigrationScoreJson: null,
      schemaVersion: 0,
    })
    .where(eq(scoreVersions.id, id))

  return true
}

/**
 * Janitor: trim pre_migration_score_json on rows older than the
 * retention window. Default 90 days. Called from the periodic
 * janitor job once the migration is verified safe in production.
 */
export async function trimMigrationSidecars(
  db: DB,
  retentionEpochSecondsCutoff: number,
): Promise<number> {
  const result = await db
    .update(scoreVersions)
    .set({ preMigrationScoreJson: null })
    .where(lt(scoreVersions.createdAt, retentionEpochSecondsCutoff))

  // better-sqlite3 driver returns .changes; portable count via raw run.
  // For the typed-Drizzle result we approximate via a count query later.
  return (result as unknown as { changes?: number }).changes ?? 0
}
