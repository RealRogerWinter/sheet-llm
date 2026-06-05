// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'
import { creditPurchases, usageLedger, users } from '@/lib/db/schema'
import { DEFAULT_TRANSACTIONS_LIMIT, listRecentTransactions } from '@/lib/billing/transactions'

type Db = ReturnType<typeof makeTestDb>

function makeUser(db: Db, id: string): void {
  db.insert(users).values({ id, createdAt: 0, lastSeenAt: 0 }).run()
}

function purchase(
  db: Db,
  o: {
    id: string
    userId: string
    source: string
    creditsDelta: number
    amountMinorUsd?: number
    status?: string
    createdAt: number
  },
): void {
  db.insert(creditPurchases)
    .values({
      id: o.id,
      userId: o.userId,
      source: o.source,
      creditsDelta: o.creditsDelta,
      amountMinorUsd: o.amountMinorUsd ?? null,
      currency: o.amountMinorUsd != null ? 'usd' : null,
      status: o.status ?? 'settled',
      externalRef: `ext_${o.id}`,
      createdAt: o.createdAt,
    })
    .run()
}

function ledger(
  db: Db,
  o: { id: string; userId: string; kind: string; creditsCharged: number; reason?: string; createdAt: number },
): void {
  db.insert(usageLedger)
    .values({
      id: o.id,
      userId: o.userId,
      requestId: `req_${o.id}`,
      idempotencyKey: `idem_${o.id}`,
      kind: o.kind,
      reason: o.reason ?? null,
      creditsCharged: o.creditsCharged,
      createdAt: o.createdAt,
    })
    .run()
}

describe('listRecentTransactions', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    makeUser(db, 'u1')
    makeUser(db, 'u2')
  })

  it('merges purchases + ledger newest-first with signed wallet deltas + mapped labels', () => {
    purchase(db, { id: 'p1', userId: 'u1', source: 'stripe', creditsDelta: 1050, amountMinorUsd: 1000, createdAt: 100 })
    ledger(db, { id: 'l1', userId: 'u1', kind: 'chat_generate', creditsCharged: 23, createdAt: 200 })
    ledger(db, { id: 'l2', userId: 'u1', kind: 'chat_edit', creditsCharged: 11, createdAt: 300 })
    ledger(db, { id: 'l3', userId: 'u1', kind: 'refund', reason: 'error', creditsCharged: -23, createdAt: 400 })

    const tx = listRecentTransactions('u1', 50, db)
    expect(tx.map((t) => t.id)).toEqual(['l3', 'l2', 'l1', 'p1']) // newest first

    const byId = Object.fromEntries(tx.map((t) => [t.id, t]))
    // A purchase adds credits (+), carries the USD paid.
    expect(byId.p1).toMatchObject({ type: 'purchase', creditsDelta: 1050, amountMinorUsd: 1000, description: 'Credit purchase' })
    // A generation/edit SPENDS (negative wallet delta), no USD.
    expect(byId.l1).toMatchObject({ type: 'generation', creditsDelta: -23, description: 'Generation', amountMinorUsd: null })
    expect(byId.l2).toMatchObject({ type: 'edit', creditsDelta: -11, description: 'Edit' })
    // A refund row (negative creditsCharged) credits back (+) and names the reason.
    expect(byId.l3).toMatchObject({ type: 'refund', creditsDelta: 23, description: 'Refund (error)' })
  })

  it('scopes strictly to the user', () => {
    purchase(db, { id: 'p1', userId: 'u1', source: 'stripe', creditsDelta: 500, createdAt: 1 })
    purchase(db, { id: 'p2', userId: 'u2', source: 'stripe', creditsDelta: 500, createdAt: 2 })
    expect(listRecentTransactions('u1', 50, db).map((t) => t.id)).toEqual(['p1'])
  })

  it('excludes non-settled purchases (pending/reversed never net-moved the balance)', () => {
    purchase(db, { id: 'pp', userId: 'u1', source: 'stripe', creditsDelta: 500, status: 'pending', createdAt: 1 })
    purchase(db, { id: 'pr', userId: 'u1', source: 'stripe', creditsDelta: 500, status: 'reversed', createdAt: 2 })
    purchase(db, { id: 'ps', userId: 'u1', source: 'stripe', creditsDelta: 500, status: 'settled', createdAt: 3 })
    expect(listRecentTransactions('u1', 50, db).map((t) => t.id)).toEqual(['ps'])
  })

  it('applies the settled filter BEFORE the limit — pending/reversed rows cannot starve settled ones', () => {
    // Five NEWER pending rows + one OLD settled row, with a tiny limit. A
    // post-limit JS filter would return [] (the limit eats the pending rows); the
    // SQL where-clause keeps the settled row in the page.
    for (let i = 0; i < 5; i++) purchase(db, { id: `pend${i}`, userId: 'u1', source: 'stripe', creditsDelta: 9, status: 'pending', createdAt: 1000 + i })
    purchase(db, { id: 'old-settled', userId: 'u1', source: 'stripe', creditsDelta: 500, status: 'settled', createdAt: 1 })
    expect(listRecentTransactions('u1', 2, db).map((t) => t.id)).toEqual(['old-settled'])
  })

  it('caps at the limit across BOTH tables (true top-N, not N-per-table)', () => {
    for (let i = 0; i < 5; i++) ledger(db, { id: `l${i}`, userId: 'u1', kind: 'chat_generate', creditsCharged: 1, createdAt: 100 + i })
    for (let i = 0; i < 5; i++) purchase(db, { id: `p${i}`, userId: 'u1', source: 'stripe', creditsDelta: 1, createdAt: 200 + i })
    const tx = listRecentTransactions('u1', 3, db)
    expect(tx.length).toBe(3)
    expect(tx.map((t) => t.id)).toEqual(['p4', 'p3', 'p2']) // the newest 3 overall (all purchases here)
  })

  it('maps promo / manual / refund purchase sources', () => {
    purchase(db, { id: 'a', userId: 'u1', source: 'promo', creditsDelta: 100, createdAt: 1 })
    purchase(db, { id: 'b', userId: 'u1', source: 'manual', creditsDelta: 50, createdAt: 2 })
    purchase(db, { id: 'c', userId: 'u1', source: 'refund', creditsDelta: -30, createdAt: 3 })
    const byId = Object.fromEntries(listRecentTransactions('u1', 50, db).map((t) => [t.id, t]))
    expect(byId.a).toMatchObject({ type: 'adjustment', description: 'Promotional credit' })
    expect(byId.b).toMatchObject({ type: 'adjustment', description: 'Account adjustment' })
    expect(byId.c).toMatchObject({ type: 'refund', description: 'Refund', creditsDelta: -30 })
  })

  it('defaults + clamps a garbage limit to the default', () => {
    expect(DEFAULT_TRANSACTIONS_LIMIT).toBe(50)
    ledger(db, { id: 'l', userId: 'u1', kind: 'chat_generate', creditsCharged: 1, createdAt: 1 })
    expect(listRecentTransactions('u1', 0, db).length).toBe(1) // 0 → default
    expect(listRecentTransactions('u1', -5, db).length).toBe(1) // negative → default
    expect(listRecentTransactions('u1', Number.NaN, db).length).toBe(1)
  })

  it('returns [] for a user with no activity', () => {
    expect(listRecentTransactions('u1', 50, db)).toEqual([])
  })
})
