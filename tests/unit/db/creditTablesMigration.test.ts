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

// 0010 hardened the wallet solvency invariant + linked the ledger to holds;
// 0011 added the refund engine's column + ceiling table. Assert the facts the
// money code depends on so a future snapshot edit can't silently drop them.
describe('0010 + 0011 refinements migration', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('0010: credit_wallets CHECK forbids held > balance (no over-reservation at rest)', () => {
    const client = raw(makeTestDb())
    client.pragma('foreign_keys = OFF')
    const insert = client.prepare(
      'INSERT INTO credit_wallets (user_id, balance, held, version, updated_at) VALUES (?,?,?,?,?)',
    )
    expect(() => insert.run('u-overheld', 10, 20, 0, 0)).toThrow(/CHECK/i) // held > balance
    expect(() => insert.run('u-solvent', 20, 10, 0, 0)).not.toThrow()
  })

  it('0010: usage_ledger.hold_id FK-references credit_holds', () => {
    const client = raw(makeTestDb())
    const fks = client.pragma('foreign_key_list(usage_ledger)') as Array<{ table: string }>
    expect(fks.some((f) => f.table === 'credit_holds')).toBe(true)
  })

  it('0010: credit_holds.idempotency_key is UNIQUE (hold placement is idempotent)', () => {
    const client = raw(makeTestDb())
    const uniques = (client.pragma('index_list(credit_holds)') as Array<{ name: string; unique: number }>)
      .filter((i) => i.unique === 1)
      .map((i) => i.name)
    expect(uniques.some((n) => n.includes('idempotency_key'))).toBe(true)
  })

  it('0011: usage_ledger gains a nullable reason column (refund audit)', () => {
    const client = raw(makeTestDb())
    const cols = client.pragma('table_info(usage_ledger)') as Array<{ name: string; notnull: number }>
    const reason = cols.find((c) => c.name === 'reason')
    expect(reason, 'usage_ledger.reason missing').toBeDefined()
    expect(reason!.notnull).toBe(0) // nullable — NULL on a normal charge
  })

  it('0011: refund_counters has a composite (user_id, day) PK and a users FK cascade', () => {
    const client = raw(makeTestDb())
    const cols = client.pragma('table_info(refund_counters)') as Array<{ name: string; pk: number }>
    expect(cols.length, 'refund_counters table missing').toBeGreaterThan(0)
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort()
    expect(pkCols).toEqual(['day', 'user_id'])
    const userFk = (client.pragma('foreign_key_list(refund_counters)') as Array<{
      table: string
      on_delete: string
    }>).find((f) => f.table === 'users')
    expect(userFk?.on_delete).toBe('CASCADE')
  })

  it('0011: refund_counters CHECK forbids negative counters', () => {
    const client = raw(makeTestDb())
    client.pragma('foreign_keys = OFF')
    const insert = client.prepare(
      'INSERT INTO refund_counters (user_id, day, refund_count, refund_credits, updated_at) VALUES (?,?,?,?,?)',
    )
    expect(() => insert.run('u-neg', 0, -1, 0, 0)).toThrow(/CHECK/i)
    expect(() => insert.run('u-ok', 0, 1, 5, 0)).not.toThrow()
  })
})

// 0012 added the Stripe webhook raw-events inbox.
describe('0012_stripe_events migration', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('creates stripe_events with event_id as the PK and the reaper indexes', () => {
    const client = raw(makeTestDb())
    const cols = client.pragma('table_info(stripe_events)') as Array<{ name: string; pk: number }>
    expect(cols.length, 'stripe_events table missing').toBeGreaterThan(0)
    expect(cols.find((c) => c.name === 'event_id')?.pk).toBe(1)
    const idx = (client.pragma('index_list(stripe_events)') as Array<{ name: string }>).map((i) => i.name)
    expect(idx).toContain('stripe_events_status')
    expect(idx).toContain('stripe_events_received')
  })

  it('stripe_events deliberately has NO users FK (a retained financial record survives erasure)', () => {
    const client = raw(makeTestDb())
    const fks = client.pragma('foreign_key_list(stripe_events)') as Array<{ table: string }>
    expect(fks.length).toBe(0)
  })
})

// 0013 added a plain index on orchestrator_turns.request_id so the credit
// paywall (PR-7b) can settle a non-streaming turn off its cost by request id.
describe('0013_orchestrator_turns_request_index migration', () => {
  const raw = (db: ReturnType<typeof makeTestDb>): Database.Database => db.$client

  it('indexes orchestrator_turns.request_id (NON-unique — a streaming turn + its backfill share one)', () => {
    const client = raw(makeTestDb())
    const indexes = client.pragma('index_list(orchestrator_turns)') as Array<{
      name: string
      unique: number
    }>
    const reqIdx = indexes.find((i) => i.name === 'orchestrator_turns_request')
    expect(reqIdx, 'orchestrator_turns_request index missing').toBeDefined()
    expect(reqIdx!.unique).toBe(0) // plain index, not unique
    const cols = (
      client.pragma('index_info(orchestrator_turns_request)') as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toEqual(['request_id'])
  })
})
