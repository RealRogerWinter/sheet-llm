import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import path from 'node:path'
import * as schema from './schema'
import {
  assertJournalModeForReplication,
  isReplicationConfigured,
  migrateWithRetry,
} from './durability'

type DbInstance = BetterSQLite3Database<typeof schema>

declare global {
  // HMR-safe singleton: Next.js dev re-evaluates modules on hot reload,
  // and we don't want a new SQLite connection per reload.
  var __sheetllm_db: DbInstance | undefined
  var __sheetllm_db_migrated: WeakSet<DbInstance> | undefined
}

function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL ?? 'file:./data/sheet-llm.db'
  if (!raw.startsWith('file:')) {
    throw new Error(
      `[db] Unsupported DATABASE_URL "${raw}". Only file:* (SQLite) is supported in this build.`,
    )
  }
  // Accept any of the spec-compliant forms: file:path, file:/path, file:///path.
  // Collapse the RFC 8089 // authority prefix to a single slash so we get a
  // plain filesystem path on Linux and avoid Windows interpreting it as UNC.
  let pathPart = raw.slice('file:'.length)
  if (pathPart.startsWith('//')) {
    pathPart = pathPart.replace(/^\/{2,}/, '/')
  }
  if (pathPart === '') {
    throw new Error(
      `[db] DATABASE_URL "${raw}" resolved to an empty path; expected file:./path or file:///abs/path.`,
    )
  }
  return pathPart
}

function openDb(): DbInstance {
  const file = resolveDbPath()
  const isMemory = file === ':memory:'
  // An in-memory DB can't be replicated, so refuse it under a replication config
  // rather than boot a data-losing setup the operator believes is durable.
  if (isMemory && isReplicationConfigured()) {
    throw new Error(
      '[db] FATAL: replication is configured (LITESTREAM_REPLICA_URL / SL_REQUIRE_WAL) but ' +
        'DATABASE_URL is :memory: — an in-memory database cannot be replicated and loses all ' +
        'data on restart. Use a file: path. Refusing to start.',
    )
  }
  if (!isMemory) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  const sqlite = new Database(file)
  // WAL is persistent across connections on file DBs and a no-op on :memory:;
  // skip it for in-memory to avoid the silent downgrade to journal_mode='memory'
  // that obscures the real configuration. On a read-only filesystem WAL also
  // can't create its sidecar files, so we surface the actual mode if it isn't 'wal'.
  if (!isMemory) {
    const mode = sqlite.pragma('journal_mode = WAL', { simple: true })
    // FATAL when replication is configured but WAL didn't stick: Litestream can't
    // replicate a non-WAL db, so booting would mean silent data-loss-on-wipe.
    assertJournalModeForReplication(mode)
    if (mode !== 'wal') {
      console.warn(
        `[db] requested journal_mode=WAL but SQLite returned "${mode}"; ` +
          `writes will serialize through the writer lock.`,
      )
    }
  }
  sqlite.pragma('foreign_keys = ON')
  return drizzle(sqlite, { schema })
}

/**
 * Lazy singleton accessor. Avoids module-load side effects: tests,
 * build-time collectors, and ESLint plugins can `import` paths that
 * transitively reach this file without ever needing a real DB connection.
 */
export function getDb(): DbInstance {
  if (!globalThis.__sheetllm_db) {
    globalThis.__sheetllm_db = openDb()
  }
  return globalThis.__sheetllm_db
}

/**
 * Test-only: replace the process-global DB singleton. Pass `undefined`
 * in afterEach to reset. Use with `tests/factories/db.ts#makeTestDb()`
 * to swap a fresh :memory: instance into the route handlers' code path.
 *
 * Production code MUST NOT call this.
 */
export function setDbForTesting(db: DbInstance | undefined): void {
  globalThis.__sheetllm_db = db
}

/**
 * Apply any pending Drizzle migrations to `targetDb`. Idempotent: each
 * distinct DB instance is migrated once per process via a WeakSet, so
 * tests that pass their own :memory: instances stay correct without
 * poisoning the singleton's flag.
 *
 * Production: called once on server boot from src/instrumentation.ts.
 * Tests: tests/factories/db.ts calls it on each fresh :memory: build.
 */
export function ensureMigrationsApplied(
  targetDb: DbInstance = getDb(),
): void {
  if (!globalThis.__sheetllm_db_migrated) {
    globalThis.__sheetllm_db_migrated = new WeakSet()
  }
  if (globalThis.__sheetllm_db_migrated.has(targetDb)) return
  const migrationsFolder = path.resolve(process.cwd(), 'drizzle')
  if (!fs.existsSync(migrationsFolder)) {
    throw new Error(
      `[db] Migrations folder not found at "${migrationsFolder}". ` +
        `In Docker / Next.js standalone builds, add 'drizzle' to ` +
        `next.config.ts outputFileTracingIncludes.`,
    )
  }
  // Retry on a transient writer lock (a sibling process finishing on a deploy
  // crossover) so a lock can't crash-loop the app; real failures still throw.
  migrateWithRetry(() => migrate(targetDb, { migrationsFolder }), {
    onRetry: (attempt, delayMs) =>
      console.warn(`[db] migration blocked by a writer lock (attempt ${attempt}); retrying in ${delayMs}ms`),
  })
  globalThis.__sheetllm_db_migrated.add(targetDb)
}

export { schema }
