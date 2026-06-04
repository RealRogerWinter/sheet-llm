// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../../factories/db'
import { users } from '@/lib/db/schema'
import {
  creditWallet,
  ensureWallet,
  getWallet,
  placeHold,
  reapExpiredHolds,
  releaseHold,
  settleHold,
} from '@/lib/billing/wallet'

type Db = ReturnType<typeof makeTestDb>

function makeUser(db: Db, id: string): void {
  db.insert(users).values({ id, createdAt: 0, lastSeenAt: 0 }).run()
}

describe('wallet engine', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    makeUser(db, 'u1')
  })

  it('placeHold fails CLOSED on an empty wallet', () => {
    ensureWallet('u1', db)
    const r = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 10 }, db)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('insufficient_credits')
      expect(r.available).toBe(0)
    }
  })

  it('credit → hold reserves (held up, available down), balance unchanged', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    expect(placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 30 }, db).ok).toBe(true)
    expect(getWallet('u1', db)).toEqual({ balance: 100, held: 30, available: 70 })
  })

  it('guard-in-the-write: cannot reserve more than available', () => {
    creditWallet({ userId: 'u1', creditsDelta: 50, source: 'manual' }, db)
    expect(placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db).ok).toBe(true)
    const second = placeHold({ userId: 'u1', requestId: 'r2', idempotencyKey: 'k2', credits: 20 }, db)
    expect(second.ok).toBe(false) // only 10 available
    if (!second.ok) expect(second.available).toBe(10)
  })

  it('placeHold is idempotent on idempotencyKey (no double-reserve)', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const a = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 30 }, db)
    const b = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 30 }, db)
    expect(a.ok && b.ok && a.holdId === b.holdId).toBe(true)
    expect(getWallet('u1', db).held).toBe(30) // not 60
  })

  it('settle debits the ACTUAL charge and refunds the rest of the hold', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db)
    if (!h.ok) throw new Error('hold failed')
    const s = settleHold(
      { holdId: h.holdId, creditsCharged: 23, costMicroUsd: 90_000, kind: 'chat_generate', requestId: 'r1', idempotencyKey: 'led-1' },
      db,
    )
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.creditsCharged).toBe(23)
      expect(s.overHold).toBe(false)
      expect(s.balanceAfter).toBe(77)
    }
    expect(getWallet('u1', db)).toEqual({ balance: 77, held: 0, available: 77 })
  })

  it('settle is idempotent on the ledger key (no double-debit)', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db)
    if (!h.ok) throw new Error('hold failed')
    const args = { holdId: h.holdId, creditsCharged: 23, kind: 'chat_generate', requestId: 'r1', idempotencyKey: 'led-1' }
    settleHold(args, db)
    settleHold(args, db)
    expect(getWallet('u1', db).balance).toBe(77) // debited exactly once
  })

  it('over-hold settle is CAPPED at the reservation (no overdraft, flagged)', () => {
    creditWallet({ userId: 'u1', creditsDelta: 50, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 30 }, db)
    if (!h.ok) throw new Error('hold failed')
    const s = settleHold(
      { holdId: h.holdId, creditsCharged: 999, kind: 'chat_generate', requestId: 'r1', idempotencyKey: 'led-1' },
      db,
    )
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.overHold).toBe(true)
      expect(s.creditsCharged).toBe(30) // capped at the hold
    }
    expect(getWallet('u1', db)).toEqual({ balance: 20, held: 0, available: 20 }) // never negative
  })

  it('settle on a non-active hold is refused', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db)
    if (!h.ok) throw new Error('hold failed')
    releaseHold(h.holdId, db)
    const s = settleHold({ holdId: h.holdId, creditsCharged: 10, kind: 'x', requestId: 'r1', idempotencyKey: 'led-1' }, db)
    expect(s.ok).toBe(false)
  })

  it('release gives the reservation back without debiting; a second release is a no-op', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db)
    if (!h.ok) throw new Error('hold failed')
    expect(releaseHold(h.holdId, db).released).toBe(true)
    expect(getWallet('u1', db)).toEqual({ balance: 100, held: 0, available: 100 })
    expect(releaseHold(h.holdId, db).released).toBe(false)
  })

  it('creditWallet is idempotent on externalRef (Stripe webhook replay)', () => {
    const grant = { userId: 'u1', creditsDelta: 500, source: 'stripe', externalRef: 'evt_1', amountMinorUsd: 500 }
    creditWallet(grant, db)
    creditWallet(grant, db)
    expect(getWallet('u1', db).balance).toBe(500) // credited exactly once
  })

  it('reapExpiredHolds releases stale active holds (crash recovery)', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40, ttlSec: 1 }, db)
    if (!h.ok) throw new Error('hold failed')
    expect(getWallet('u1', db).held).toBe(40)
    expect(reapExpiredHolds(db, 10_000_000_000)).toBe(1) // clock far in the future
    expect(getWallet('u1', db).held).toBe(0)
  })
})
