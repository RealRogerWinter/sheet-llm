// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { creditWallets, usageLedger, users } from '@/lib/db/schema'
import {
  creditWallet,
  DAILY_REFUND_MAX_COUNT,
  DAILY_REFUND_MAX_CREDITS,
  ensureWallet,
  getWallet,
  placeHold,
  reapExpiredHolds,
  refund,
  releaseHold,
  settleHold,
} from '@/lib/billing/wallet'
import { PER_FAILURE_REFUND_CAP_CREDITS } from '@/lib/billing/refundPolicy'

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
    if (a.ok) expect(a.reused).toBe(false)
    if (b.ok) {
      expect(b.reused).toBe(true)
      expect(b.status).toBe('active')
    }
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

  it('settle against a missing wallet THROWS (no phantom ledger row)', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db)
    if (!h.ok) throw new Error('hold failed')
    db.delete(creditWallets).where(eq(creditWallets.userId, 'u1')).run() // wallet vanishes
    expect(() =>
      settleHold({ holdId: h.holdId, creditsCharged: 23, kind: 'x', requestId: 'r1', idempotencyKey: 'led-1' }, db),
    ).toThrow()
    expect(db.select().from(usageLedger).all()).toHaveLength(0) // rolled back: no phantom row
  })

  it('creditWallet refuses a debit that would drop balance below held', () => {
    creditWallet({ userId: 'u1', creditsDelta: 50, source: 'manual' }, db)
    placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 30 }, db) // held 30, available 20
    const r = creditWallet({ userId: 'u1', creditsDelta: -40, source: 'refund', externalRef: 'ref-1' }, db)
    expect(r.applied).toBe(false)
    if (!r.applied) expect(r.reason).toBe('insufficient_balance')
    expect(getWallet('u1', db).balance).toBe(50) // unchanged
  })
})

describe('wallet refund (service failures)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    makeUser(db, 'u1')
    // Simulate a prior spend: top up then settle a 30-credit charge.
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'manual' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 40 }, db)
    if (!h.ok) throw new Error('hold failed')
    settleHold({ holdId: h.holdId, creditsCharged: 30, kind: 'chat_generate', requestId: 'r1', idempotencyKey: 'led-1' }, db)
    // Balance now 70.
  })

  it('credits the balance back and writes a NEGATIVE-charge ledger row', () => {
    const r = refund(
      { userId: 'u1', requestId: 'r1', holdId: undefined, credits: 30, reason: 'error', idempotencyKey: 'rf-1', costMicroUsd: 90_000 },
      db,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.creditsRefunded).toBe(30)
      expect(r.balanceAfter).toBe(100)
      expect(r.reused).toBe(false)
    }
    expect(getWallet('u1', db)).toEqual({ balance: 100, held: 0, available: 100 })
    const row = db.select().from(usageLedger).where(eq(usageLedger.idempotencyKey, 'rf-1')).get()
    expect(row?.kind).toBe('refund')
    expect(row?.reason).toBe('error')
    expect(row?.creditsCharged).toBe(-30) // double-entry: a charge reversed
    // SUM(credits_charged) over the request = net spend = 0 (charged 30, refunded 30).
    const net = db.select().from(usageLedger).all().reduce((s, x) => s + x.creditsCharged, 0)
    expect(net).toBe(0)
  })

  it('is idempotent on idempotencyKey (no double-credit), and the reused row echoes the same amounts', () => {
    const a = refund({ userId: 'u1', requestId: 'r1', credits: 30, reason: 'error', idempotencyKey: 'rf-1' }, db)
    const b = refund({ userId: 'u1', requestId: 'r1', credits: 30, reason: 'error', idempotencyKey: 'rf-1' }, db)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok) {
      expect(a.reused).toBe(false)
      expect(a.creditsRefunded).toBe(30)
    }
    if (b.ok) {
      expect(b.reused).toBe(true)
      expect(b.creditsRefunded).toBe(30) // echoes the original, not 0 / not negated-twice
      expect(b.balanceAfter).toBe(100)
    }
    expect(getWallet('u1', db).balance).toBe(100) // credited exactly once, not 130
  })

  it('THROWS if a settle key is reused as a refund key (shared idempotency namespace)', () => {
    // beforeEach already settled a charge under key 'led-1'. Refunding with the
    // same key would otherwise short-circuit and report a money-less success.
    expect(() =>
      refund({ userId: 'u1', requestId: 'r1', credits: 30, reason: 'error', idempotencyKey: 'led-1' }, db),
    ).toThrow(/namespaced/)
    expect(getWallet('u1', db).balance).toBe(70) // unchanged — nothing credited
  })

  it('THROWS if a refund key is reused as a settle key (the symmetric guard)', () => {
    refund({ userId: 'u1', requestId: 'r1', credits: 20, reason: 'error', idempotencyKey: 'rf-shared' }, db)
    const h = placeHold({ userId: 'u1', requestId: 'r2', idempotencyKey: 'k-sym', credits: 10 }, db)
    if (!h.ok) throw new Error('hold failed')
    expect(() =>
      settleHold({ holdId: h.holdId, creditsCharged: 5, kind: 'chat_generate', requestId: 'r2', idempotencyKey: 'rf-shared' }, db),
    ).toThrow(/namespaced/)
  })

  it('enforces the daily COUNT ceiling', () => {
    // Many tiny refunds (1 credit each) so the credit-sum ceiling never trips first.
    for (let i = 0; i < DAILY_REFUND_MAX_COUNT; i++) {
      const r = refund({ userId: 'u1', requestId: 'r1', credits: 1, reason: 'error', idempotencyKey: `rf-${i}` }, db)
      expect(r.ok).toBe(true)
    }
    const over = refund({ userId: 'u1', requestId: 'r1', credits: 1, reason: 'error', idempotencyKey: 'rf-over' }, db)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toBe('ceiling_exceeded')
  })

  it('enforces the daily CREDIT-SUM ceiling', () => {
    // First refund takes almost the whole daily budget; the next small one trips it.
    const big = refund({ userId: 'u1', requestId: 'r1', credits: DAILY_REFUND_MAX_CREDITS, reason: 'error', idempotencyKey: 'rf-big' }, db)
    expect(big.ok).toBe(true)
    const more = refund({ userId: 'u1', requestId: 'r1', credits: 1, reason: 'error', idempotencyKey: 'rf-more' }, db)
    expect(more.ok).toBe(false)
    if (!more.ok) expect(more.reason).toBe('ceiling_exceeded')
  })

  it('refuses a single refund larger than the daily ceiling', () => {
    const r = refund({ userId: 'u1', requestId: 'r1', credits: DAILY_REFUND_MAX_CREDITS + 1, reason: 'error', idempotencyKey: 'rf-huge' }, db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('ceiling_exceeded')
    expect(getWallet('u1', db).balance).toBe(70) // unchanged
  })

  it('a ceiling-refused refund consumes no budget (the counter rolls back)', () => {
    const near = DAILY_REFUND_MAX_CREDITS - 5
    const a = refund({ userId: 'u1', requestId: 'r1', credits: near, reason: 'error', idempotencyKey: 'rf-a' }, db)
    expect(a.ok).toBe(true) // counter = near
    const b = refund({ userId: 'u1', requestId: 'r1', credits: 10, reason: 'error', idempotencyKey: 'rf-b' }, db)
    expect(b.ok).toBe(false) // near+10 > MAX → refused mid-txn, rolled back
    // If b had wrongly consumed budget the counter would be near+10 and this
    // 5-credit refund (near+5 == MAX) would fail. It succeeds → b consumed nothing.
    const c = refund({ userId: 'u1', requestId: 'r1', credits: 5, reason: 'error', idempotencyKey: 'rf-c' }, db)
    expect(c.ok).toBe(true)
    expect(getWallet('u1', db).balance).toBe(70 + near + 5)
  })

  it('links the refund ledger row to a real holdId (FK)', () => {
    const h = placeHold({ userId: 'u1', requestId: 'r9', idempotencyKey: 'k9', credits: 10 }, db)
    if (!h.ok) throw new Error('hold failed')
    settleHold({ holdId: h.holdId, creditsCharged: 8, kind: 'chat_generate', requestId: 'r9', idempotencyKey: 'led-9' }, db)
    const r = refund({ userId: 'u1', requestId: 'r9', holdId: h.holdId, credits: 8, reason: 'error', idempotencyKey: 'rf-9' }, db)
    expect(r.ok).toBe(true)
    const row = db.select().from(usageLedger).where(eq(usageLedger.idempotencyKey, 'rf-9')).get()
    expect(row?.holdId).toBe(h.holdId)
  })

  it('per-failure cap stays safely below the daily ceiling (sizing invariant)', () => {
    // Defense-in-depth: if a future tuning edit inverted these, a single
    // first-of-day refund could bypass the unguarded INSERT path.
    expect(PER_FAILURE_REFUND_CAP_CREDITS).toBeLessThan(DAILY_REFUND_MAX_CREDITS)
  })
})
