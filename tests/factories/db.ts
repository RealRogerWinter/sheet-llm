import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import * as schema from '@/lib/db/schema'

/**
 * Build a fresh, fully-migrated in-memory SQLite database for a single
 * test (or describe block). Each call yields a brand-new connection — no
 * shared state between callers.
 */
export function makeTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') })
  return db
}
