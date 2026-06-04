// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'

// Guards the BLOCKING `pnpm test` job against drizzle journal/snapshot drift:
// makeTestDb() applies EVERY migration in drizzle/ (including 0007_daily_quota)
// through the same migrator the container runs on boot. If 0007 ever stops
// applying — or the snapshot chain drifts again (see the 0003–0005 history) —
// this fails fast with a clear message instead of a mysterious boot crash.
describe('0007_daily_quota migration', () => {
  // The raw better-sqlite3 handle, for PRAGMA introspection.
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('applies cleanly and creates request_quota with the expected shape', () => {
    const db = makeTestDb() // throws here if any migration fails to apply
    const client = raw(db)

    const cols = client.pragma('table_info(request_quota)') as Array<{
      name: string
      notnull: number
      pk: number
    }>
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))

    expect(Object.keys(byName).sort()).toEqual([
      'count',
      'quota_key',
      'updated_at',
      'user_id',
      'window_start',
    ])
    expect(byName.quota_key.pk).toBe(1) // PRIMARY KEY
    expect(byName.window_start.notnull).toBe(1)
    expect(byName.count.notnull).toBe(1)
    expect(byName.updated_at.notnull).toBe(1)
    expect(byName.user_id.notnull).toBe(0) // nullable for anon/instance rows
  })

  it('indexes window_start (bounds the retention reaper scan)', () => {
    const client = raw(makeTestDb())
    const indexes = client.pragma('index_list(request_quota)') as Array<{
      name: string
    }>
    expect(indexes.some((i) => i.name === 'request_quota_window')).toBe(true)
  })

  it('declares the users FK with ON DELETE CASCADE (GDPR erasure)', () => {
    const client = raw(makeTestDb())
    const fks = client.pragma('foreign_key_list(request_quota)') as Array<{
      table: string
      on_delete: string
    }>
    expect(fks).toHaveLength(1)
    expect(fks[0].table).toBe('users')
    expect(fks[0].on_delete).toBe('CASCADE')
  })
})
