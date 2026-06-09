// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'

// SHE-18 PR4 — training_pairs is the hosted-only, flag-gated CONSENT MARKER
// for training-data capture: a thin row per consented turn (turn_id +
// salted session_hash + captured_at). orchestrator_turns stays the source of
// truth; the export (PR5) joins back. makeTestDb() runs every migration, so a
// broken 0018 CREATE fails fast here.
describe('0018 training_pairs (SHE-18 PR4)', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('creates training_pairs with the marker columns', () => {
    const cols = Object.fromEntries(
      (
        raw(makeTestDb()).pragma('table_info(training_pairs)') as Array<{
          name: string
          notnull: number
          pk: number
        }>
      ).map((c) => [c.name, c]),
    )
    expect(Object.keys(cols).sort()).toEqual([
      'captured_at',
      'id',
      'session_hash',
      'turn_id',
    ])
    expect(cols.id.pk).toBe(1)
    expect(cols.turn_id.notnull).toBe(1)
    expect(cols.session_hash.notnull).toBe(1)
    expect(cols.captured_at.notnull).toBe(1)
  })

  it('turn_id is UNIQUE (a turn is captured at most once) and indexed; captured_at indexed', () => {
    const client = raw(makeTestDb())
    const uniques = (
      client.pragma('index_list(training_pairs)') as Array<{ name: string; unique: number }>
    )
      .filter((i) => i.unique === 1)
      .map((i) => i.name)
    expect(uniques.some((n) => n.includes('turn'))).toBe(true)
    const idx = (client.pragma('index_list(training_pairs)') as Array<{ name: string }>).map(
      (i) => i.name,
    )
    expect(idx.some((n) => n.includes('captured'))).toBe(true)
  })

  it('turn_id FK cascades from orchestrator_turns (a deleted turn drops its marker)', () => {
    const fks = raw(makeTestDb()).pragma('foreign_key_list(training_pairs)') as Array<{
      table: string
      on_delete: string
    }>
    const turnFk = fks.find((f) => f.table === 'orchestrator_turns')
    expect(turnFk, 'training_pairs missing orchestrator_turns FK').toBeDefined()
    expect(turnFk!.on_delete).toBe('CASCADE')
  })
})
