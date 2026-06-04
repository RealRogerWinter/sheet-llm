// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'

// Guards the BLOCKING test job against drizzle journal/snapshot drift for the
// prepaid-credits tables: makeTestDb() applies EVERY migration (incl.
// 0009_credit_tables) through the same migrator the container runs on boot, so
// a snapshot-chain drift or a broken CREATE fails fast here, not at boot.
describe('0009_credit_tables migration', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('applies cleanly and creates the four credit tables', () => {
    const client = raw(makeTestDb())
    for (const t of ['credit_wallets', 'credit_purchases', 'usage_ledger', 'credit_holds']) {
      const cols = client.pragma(`table_info(${t})`) as Array<{ name: string }>
      expect(cols.length, `missing table ${t}`).toBeGreaterThan(0)
    }
  })

  it('credit_wallets: user_id PK, non-null balance/held/version', () => {
    const client = raw(makeTestDb())
    const cols = Object.fromEntries(
      (
        client.pragma('table_info(credit_wallets)') as Array<{
          name: string
          notnull: number
          pk: number
        }>
      ).map((c) => [c.name, c]),
    )
    expect(Object.keys(cols).sort()).toEqual([
      'balance',
      'held',
      'updated_at',
      'user_id',
      'version',
    ])
    expect(cols.user_id.pk).toBe(1)
    expect(cols.balance.notnull).toBe(1)
    expect(cols.held.notnull).toBe(1)
    expect(cols.version.notnull).toBe(1)
  })

  it('credit_wallets CHECK rejects a negative balance or held (no overdraft at rest)', () => {
    const client = raw(makeTestDb())
    client.pragma('foreign_keys = OFF') // isolate the CHECK from the users FK
    const insert = client.prepare(
      'INSERT INTO credit_wallets (user_id, balance, held, version, updated_at) VALUES (?,?,?,?,?)',
    )
    expect(() => insert.run('u-neg-bal', -1, 0, 0, 0)).toThrow(/CHECK/i)
    expect(() => insert.run('u-neg-held', 0, -5, 0, 0)).toThrow(/CHECK/i)
    // A non-negative row is accepted.
    expect(() => insert.run('u-ok', 100, 0, 0, 0)).not.toThrow()
  })

  it('credit_purchases.external_ref + usage_ledger.idempotency_key are UNIQUE (idempotency)', () => {
    const client = raw(makeTestDb())
    const uniques = (table: string): string[] =>
      (
        client.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>
      )
        .filter((i) => i.unique === 1)
        .map((i) => i.name)
    expect(uniques('credit_purchases').some((n) => n.includes('external_ref'))).toBe(true)
    expect(uniques('usage_ledger').some((n) => n.includes('idempotency_key'))).toBe(true)
  })

  it('usage_ledger / credit_holds / credit_purchases all FK-cascade from users (GDPR erasure)', () => {
    const client = raw(makeTestDb())
    for (const t of ['usage_ledger', 'credit_holds', 'credit_purchases', 'credit_wallets']) {
      const fks = client.pragma(`foreign_key_list(${t})`) as Array<{
        table: string
        on_delete: string
      }>
      const userFk = fks.find((f) => f.table === 'users')
      expect(userFk, `${t} missing users FK`).toBeDefined()
      expect(userFk!.on_delete).toBe('CASCADE')
    }
  })

  it('credit_holds.expires_at is indexed (bounds the crash-recovery reaper)', () => {
    const client = raw(makeTestDb())
    const idx = (client.pragma('index_list(credit_holds)') as Array<{ name: string }>).map(
      (i) => i.name,
    )
    expect(idx).toContain('credit_holds_expires')
  })
})
