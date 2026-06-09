// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'

// SHE-18 PR1 — orchestrator_turns gains an explicit accept/reject/undo
// `outcome` label so training-data filters can keep only turns the user
// actually kept. makeTestDb() runs EVERY migration through the same
// migrator the container boots on, so a snapshot/journal drift or a broken
// 0016 ALTER fails fast here rather than at boot.
describe('0016 orchestrator_turns.outcome (SHE-18 PR1)', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('adds a nullable `outcome` column (turns start undecided)', () => {
    const client = raw(makeTestDb())
    const cols = Object.fromEntries(
      (
        client.pragma('table_info(orchestrator_turns)') as Array<{
          name: string
          notnull: number
        }>
      ).map((c) => [c.name, c]),
    )
    expect(cols.outcome, 'orchestrator_turns.outcome missing').toBeDefined()
    // Nullable: a turn has no user decision until accept/reject/undo arrives.
    expect(cols.outcome.notnull).toBe(0)
  })

  it('CHECK accepts accepted/reverted/superseded/NULL and rejects anything else', () => {
    const client = raw(makeTestDb())
    client.pragma('foreign_keys = OFF') // isolate the CHECK from the session FK
    const insert = client.prepare(
      `INSERT INTO orchestrator_turns
         (id, session_id, request_id, created_at, latency_ms, final_status, outcome)
       VALUES (?,?,?,?,?,?,?)`,
    )
    // A typo'd outcome must be rejected, not silently stored — downstream
    // export filters on these exact strings, so a bad value undercounts.
    expect(() => insert.run('t-bad', 's', 'r', 0, 0, 'ok', 'maybe')).toThrow(/CHECK/i)
    for (const ok of ['accepted', 'reverted', 'superseded', null] as const) {
      expect(() => insert.run(`t-${ok ?? 'null'}`, 's', 'r', 0, 0, 'ok', ok)).not.toThrow()
    }
  })
})
