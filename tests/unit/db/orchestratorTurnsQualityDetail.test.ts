// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'

// SHE-18 PR3 — orchestrator_turns gains preservation + replacement-gate
// detail columns that the orchestrator computes every turn but currently
// discards (only the boolean replacement_blocked + the diff ratio survive).
// makeTestDb() runs EVERY migration through the boot migrator, so a broken
// 0017 ALTER or journal drift fails fast here.
describe('0017 orchestrator_turns quality detail (SHE-18 PR3)', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('adds the five nullable quality-detail columns', () => {
    const cols = Object.fromEntries(
      (
        raw(makeTestDb()).pragma('table_info(orchestrator_turns)') as Array<{
          name: string
          notnull: number
          type: string
        }>
      ).map((c) => [c.name, c]),
    )
    for (const name of [
      'preservation_ok',
      'preservation_mismatch_count',
      'replacement_retained_identity_ratio',
      'replacement_reasons',
      'replacement_user_explicit_rewrite',
    ]) {
      expect(cols[name], `column ${name} missing`).toBeDefined()
      // All nullable: most turns (compose-from-scratch, converse, refuse)
      // have no before-score, so neither metric applies.
      expect(cols[name].notnull, `${name} should be nullable`).toBe(0)
    }
    expect(cols.replacement_retained_identity_ratio.type).toBe('REAL')
    expect(cols.replacement_reasons.type).toBe('TEXT')
  })

  it('accepts a row carrying the quality-detail values', () => {
    const client = raw(makeTestDb())
    client.pragma('foreign_keys = OFF')
    const insert = client.prepare(
      `INSERT INTO orchestrator_turns
         (id, session_id, request_id, created_at, latency_ms, final_status,
          preservation_ok, preservation_mismatch_count,
          replacement_retained_identity_ratio, replacement_reasons,
          replacement_user_explicit_rewrite)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    expect(() =>
      insert.run('t1', 's', 'r', 0, 0, 'ok', 1, 0, 0.83, '["key C → Am"]', 0),
    ).not.toThrow()
    // NULLs are allowed (the no-before-score case).
    expect(() =>
      insert.run('t2', 's', 'r', 0, 0, 'ok', null, null, null, null, null),
    ).not.toThrow()
  })
})
