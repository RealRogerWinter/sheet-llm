import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { creditHolds, creditPurchases, creditWallets, refundCounters, usageLedger } from '@/lib/db/schema'

/**
 * Prepaid-credit WALLET ENGINE — the atomic money primitives.
 *
 * All amounts are integer CREDITS (1 credit = 1 cent of customer value; see
 * src/lib/db/schema.ts). Every mutation is one synchronous better-sqlite3
 * transaction and uses guard-in-the-write so over-reservation / overdraft is
 * impossible even under concurrency, backed by the `credit_wallets_solvent`
 * CHECK (`balance >= 0 AND held >= 0 AND held <= balance`).
 *
 * Lifecycle:  ensureWallet → placeHold (reserve, fail-closed) → run the LLM
 *             → settleHold (debit the ACTUAL charge, release the rest) OR
 *               releaseHold (on failure: give the reservation back, no debit).
 * Top-ups (Stripe / promo) go through creditWallet. A crash between hold and
 * settle is recovered by reapExpiredHolds.
 *
 * DARK: nothing calls this yet — the paywall wires it into /api/chat in PR-7.
 */

type Db = ReturnType<typeof getDb>

/** Default hold TTL: long enough for the slowest sectional generation
 *  (maxDuration is 300s) plus slack; the reaper releases anything older. */
export const DEFAULT_HOLD_TTL_SEC = 900

const nowSec = (): number => Math.floor(Date.now() / 1000)

function assertCredits(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`wallet: ${label} must be a non-negative integer (got ${n})`)
  }
}

export interface WalletSnapshot {
  balance: number
  held: number
  available: number
}

/** Read a wallet (0/0 when none exists). */
export function getWallet(userId: string, db: Db = getDb()): WalletSnapshot {
  const w = db
    .select({ balance: creditWallets.balance, held: creditWallets.held })
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId))
    .get()
  const balance = w?.balance ?? 0
  const held = w?.held ?? 0
  return { balance, held, available: balance - held }
}

/**
 * Ensure a wallet row exists (idempotent). New users start at 0 — they must
 * purchase credits before any paid hold can succeed.
 */
export function ensureWallet(userId: string, db: Db = getDb()): void {
  db.insert(creditWallets)
    .values({ userId, balance: 0, held: 0, version: 0, updatedAt: nowSec() })
    .onConflictDoNothing()
    .run()
}

export type HoldStatus = 'active' | 'settled' | 'released'

export type HoldResult =
  | { ok: true; holdId: string; reused: boolean; status: HoldStatus }
  | { ok: false; reason: 'insufficient_credits'; available: number; requested: number }

/**
 * Atomically RESERVE `credits` before an LLM call. Fails CLOSED: the
 * guard-in-the-write `WHERE balance - held >= :credits` makes over-reservation
 * impossible under concurrency. Idempotent on `idempotencyKey` — a retried
 * request (or sectional section) re-finds its hold instead of stacking a
 * duplicate.
 */
export function placeHold(
  input: {
    userId: string
    requestId: string
    idempotencyKey: string
    credits: number
    ttlSec?: number
  },
  db: Db = getDb(),
): HoldResult {
  assertCredits('hold credits', input.credits)
  const now = nowSec()
  const expiresAt = now + (input.ttlSec ?? DEFAULT_HOLD_TTL_SEC)
  return db.transaction((tx): HoldResult => {
    const existing = tx
      .select({ id: creditHolds.id, status: creditHolds.status })
      .from(creditHolds)
      .where(eq(creditHolds.idempotencyKey, input.idempotencyKey))
      .get()
    if (existing) {
      // Idempotent retry. `status` tells the caller whether the original
      // request already completed (settled/released) — a TERMINAL hold must NOT
      // be treated as a fresh reservation (the follow-up settle will refuse it).
      return { ok: true, holdId: existing.id, reused: true, status: existing.status as HoldStatus }
    }

    const res = tx
      .update(creditWallets)
      .set({
        held: sql`${creditWallets.held} + ${input.credits}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(creditWallets.userId, input.userId),
          sql`${creditWallets.balance} - ${creditWallets.held} >= ${input.credits}`,
        ),
      )
      .run()
    if (res.changes !== 1) {
      const { available } = getWallet(input.userId, tx as unknown as Db)
      return { ok: false, reason: 'insufficient_credits', available, requested: input.credits }
    }

    const holdId = randomUUID()
    tx.insert(creditHolds)
      .values({
        id: holdId,
        userId: input.userId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        credits: input.credits,
        status: 'active',
        expiresAt,
        createdAt: now,
      })
      .run()
    return { ok: true, holdId, reused: false, status: 'active' }
  })
}

export type SettleResult =
  | {
      ok: true
      ledgerId: string
      creditsCharged: number
      balanceAfter: number
      /** True when the actual charge exceeded the hold and was capped — a
       *  hold-sizing bug to investigate (we absorb the shortfall, never
       *  overdraft). */
      overHold: boolean
    }
  | { ok: false; reason: 'hold_not_active' }

/**
 * SETTLE a hold to the ACTUAL charge: in ONE atomic UPDATE, debit the real
 * charge and release the reservation, then append the immutable usage_ledger
 * row. Idempotent on the ledger `idempotencyKey`.
 *
 * The debit is `min(creditsCharged, hold.credits)` — never more than was
 * reserved — so `balance >= 0` and `held <= balance` always hold and overdraft
 * is impossible. A correctly-sized hold (worst-case) means `creditsCharged <=
 * hold.credits` and the customer is charged exactly the actual; if the charge
 * somehow exceeds the hold, `overHold` flags it and we absorb the difference.
 */
export function settleHold(
  input: {
    holdId: string
    creditsCharged: number
    costMicroUsd?: number
    kind: string
    model?: string
    generationTier?: string
    requestId: string
    sessionId?: string
    idempotencyKey: string
    inputTokens?: number
    cachedInputTokens?: number
    cacheCreationInputTokens?: number
    outputTokens?: number
  },
  db: Db = getDb(),
): SettleResult {
  assertCredits('creditsCharged', input.creditsCharged)
  const now = nowSec()
  return db.transaction((tx): SettleResult => {
    // Idempotent: a retried settle re-finds its ledger row.
    const existingLedger = tx
      .select({ id: usageLedger.id, creditsCharged: usageLedger.creditsCharged, balanceAfter: usageLedger.balanceAfter })
      .from(usageLedger)
      .where(eq(usageLedger.idempotencyKey, input.idempotencyKey))
      .get()
    if (existingLedger) {
      return {
        ok: true,
        ledgerId: existingLedger.id,
        creditsCharged: existingLedger.creditsCharged,
        balanceAfter: existingLedger.balanceAfter ?? 0,
        overHold: false,
      }
    }

    const hold = tx
      .select({
        userId: creditHolds.userId,
        credits: creditHolds.credits,
        status: creditHolds.status,
      })
      .from(creditHolds)
      .where(eq(creditHolds.id, input.holdId))
      .get()
    if (!hold || hold.status !== 'active') return { ok: false, reason: 'hold_not_active' }

    const debit = Math.min(input.creditsCharged, hold.credits)
    const overHold = input.creditsCharged > hold.credits

    const upd = tx
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} - ${debit}`,
        held: sql`${creditWallets.held} - ${hold.credits}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(eq(creditWallets.userId, hold.userId))
      .run()
    // A settle MUST debit exactly one wallet row. If it matched none (a missing
    // or inconsistent wallet), refuse — never append a usage_ledger row that
    // asserts a charge which never debited a balance. Throwing rolls the txn back.
    if (upd.changes !== 1) {
      throw new Error(
        `settleHold: wallet UPDATE matched ${upd.changes} rows for user ${hold.userId} (hold ${input.holdId})`,
      )
    }

    tx.update(creditHolds)
      .set({ status: 'settled', settledAt: now })
      .where(eq(creditHolds.id, input.holdId))
      .run()

    const { balance: balanceAfter } = getWallet(hold.userId, tx as unknown as Db)
    const ledgerId = randomUUID()
    tx.insert(usageLedger)
      .values({
        id: ledgerId,
        userId: hold.userId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        requestId: input.requestId,
        holdId: input.holdId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.generationTier !== undefined ? { generationTier: input.generationTier } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
        ...(input.cacheCreationInputTokens !== undefined
          ? { cacheCreationInputTokens: input.cacheCreationInputTokens }
          : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        ...(input.costMicroUsd !== undefined ? { costMicroUsd: input.costMicroUsd } : {}),
        creditsCharged: debit,
        balanceAfter,
        createdAt: now,
      })
      .run()

    return { ok: true, ledgerId, creditsCharged: debit, balanceAfter, overHold }
  })
}

/**
 * RELEASE a hold WITHOUT debiting (the request failed / was aborted): give the
 * reservation back. Idempotent — a non-active hold is a no-op.
 */
export function releaseHold(holdId: string, db: Db = getDb()): { released: boolean } {
  const now = nowSec()
  return db.transaction((tx): { released: boolean } => {
    const hold = tx
      .select({ userId: creditHolds.userId, credits: creditHolds.credits, status: creditHolds.status })
      .from(creditHolds)
      .where(eq(creditHolds.id, holdId))
      .get()
    if (!hold || hold.status !== 'active') return { released: false }
    tx.update(creditWallets)
      .set({
        held: sql`${creditWallets.held} - ${hold.credits}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(eq(creditWallets.userId, hold.userId))
      .run()
    tx.update(creditHolds).set({ status: 'released' }).where(eq(creditHolds.id, holdId)).run()
    return { released: true }
  })
}

export type CreditResult =
  | { applied: true; balanceAfter: number }
  | { applied: false; reason: 'duplicate' | 'insufficient_balance'; balanceAfter: number }

/**
 * Grant credits (Stripe purchase / promo / refund). Atomic: bump the balance
 * and append the immutable credit_purchases row. Idempotent on `externalRef`
 * (the Stripe event id) — a replayed webhook neither double-credits nor
 * double-inserts. `creditsDelta` may be negative (a refund).
 */
export function creditWallet(
  input: {
    userId: string
    creditsDelta: number
    source: string
    externalRef?: string
    amountMinorUsd?: number
    currency?: string
  },
  db: Db = getDb(),
): CreditResult {
  if (!Number.isInteger(input.creditsDelta)) {
    throw new Error(`wallet: creditsDelta must be an integer (got ${input.creditsDelta})`)
  }
  const now = nowSec()
  return db.transaction((tx): CreditResult => {
    if (input.externalRef) {
      const dup = tx
        .select({ id: creditPurchases.id })
        .from(creditPurchases)
        .where(eq(creditPurchases.externalRef, input.externalRef))
        .get()
      if (dup)
        return { applied: false, reason: 'duplicate', balanceAfter: getWallet(input.userId, tx as unknown as Db).balance }
    }
    tx.insert(creditWallets)
      .values({ userId: input.userId, balance: 0, held: 0, version: 0, updatedAt: now })
      .onConflictDoNothing()
      .run()
    // Guard-in-the-write: a debit (negative delta — refund/chargeback) must not
    // drop the balance below the held amount (or below 0). A positive grant
    // always passes. Avoids a raw CHECK violation on the Stripe refund path.
    const upd = tx
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${input.creditsDelta}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(creditWallets.userId, input.userId),
          sql`${creditWallets.balance} + ${input.creditsDelta} >= ${creditWallets.held}`,
        ),
      )
      .run()
    if (upd.changes !== 1) {
      return {
        applied: false,
        reason: 'insufficient_balance',
        balanceAfter: getWallet(input.userId, tx as unknown as Db).balance,
      }
    }
    tx.insert(creditPurchases)
      .values({
        id: randomUUID(),
        userId: input.userId,
        source: input.source,
        ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
        creditsDelta: input.creditsDelta,
        ...(input.amountMinorUsd !== undefined ? { amountMinorUsd: input.amountMinorUsd } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        status: 'settled',
        createdAt: now,
      })
      .run()
    return { applied: true, balanceAfter: getWallet(input.userId, tx as unknown as Db).balance }
  })
}

/** Per-user-per-DAY ceilings on SERVICE refunds (we-failed → credits back).
 *  A user-triggerable failure is a credit-printing press without a cap. Both
 *  the count AND the credit-sum are bounded. Operator-tunable defaults;
 *  re-derive from measured abuse data post-launch. */
export const DAILY_REFUND_MAX_COUNT = 20
export const DAILY_REFUND_MAX_CREDITS = 500 // = $5.00 of credit-backs / user / day

const SEC_PER_DAY = 86_400
const epochDay = (sec: number): number => Math.floor(sec / SEC_PER_DAY)

export type RefundResult =
  | { ok: true; ledgerId: string; creditsRefunded: number; balanceAfter: number; reused: boolean }
  | { ok: false; reason: 'ceiling_exceeded' }

/**
 * SERVICE refund: return `credits` to a user because WE failed (error/timeout)
 * or cost-split an unusual high-cost failure. Recorded as an immutable
 * usage_ledger row with `credits_charged` NEGATIVE (double-entry: a charge
 * reversed) + the typed `reason`, then the balance is credited back — all in
 * one atomic transaction. Idempotent on `idempotencyKey`. Bounded by a per-day
 * count AND credit-sum ceiling (guard-in-the-write) so a repeatable failure
 * can't mint unlimited credits. WHEN/how-much is decided by classifyRefund()
 * in refundPolicy.ts (this primitive only moves money safely).
 *
 * NEVER call this for a user-initiated abort or a delivered result — that is
 * the policy's job to exclude.
 */
export function refund(
  input: {
    userId: string
    requestId: string
    holdId?: string
    credits: number // positive amount to return
    reason: string // typed failure class: 'error' | 'refused' | 'cost_split'
    kind?: string // ledger kind, default 'refund'
    sessionId?: string
    idempotencyKey: string
    costMicroUsd?: number // our raw cost on the failed call (audit)
  },
  db: Db = getDb(),
): RefundResult {
  assertCredits('refund credits', input.credits)
  // A single refund must not exceed the DAILY credit ceiling: the first-of-day
  // INSERT path can't be guarded by the ON CONFLICT WHERE, so the policy cap
  // (PER_FAILURE_REFUND_CAP_CREDITS) is kept well below this and we refuse
  // defensively if a caller ever exceeds it.
  if (input.credits > DAILY_REFUND_MAX_CREDITS) return { ok: false, reason: 'ceiling_exceeded' }
  const now = nowSec()
  const day = epochDay(now)
  return db.transaction((tx): RefundResult => {
    // Idempotent: a retried refund re-finds its ledger row (NEGATIVE charge).
    const existing = tx
      .select({
        id: usageLedger.id,
        creditsCharged: usageLedger.creditsCharged,
        balanceAfter: usageLedger.balanceAfter,
      })
      .from(usageLedger)
      .where(eq(usageLedger.idempotencyKey, input.idempotencyKey))
      .get()
    if (existing) {
      return {
        ok: true,
        ledgerId: existing.id,
        creditsRefunded: -existing.creditsCharged,
        balanceAfter: existing.balanceAfter ?? 0,
        reused: true,
      }
    }

    // Daily abuse ceiling — guard-in-the-write. A NEW (user,day) row always
    // inserts (count 1, credits <= MAX checked above). On CONFLICT it increments
    // ONLY while BOTH ceilings still hold; otherwise changes=0 → refuse and the
    // whole txn rolls back (no ledger row, no balance move, counter untouched).
    const counter = tx
      .insert(refundCounters)
      .values({ userId: input.userId, day, refundCount: 1, refundCredits: input.credits, updatedAt: now })
      .onConflictDoUpdate({
        target: [refundCounters.userId, refundCounters.day],
        set: {
          refundCount: sql`${refundCounters.refundCount} + 1`,
          refundCredits: sql`${refundCounters.refundCredits} + ${input.credits}`,
          updatedAt: now,
        },
        setWhere: sql`${refundCounters.refundCount} + 1 <= ${DAILY_REFUND_MAX_COUNT} AND ${refundCounters.refundCredits} + ${input.credits} <= ${DAILY_REFUND_MAX_CREDITS}`,
      })
      .run()
    if (counter.changes !== 1) return { ok: false, reason: 'ceiling_exceeded' }

    // Credit the balance back. The wallet should already exist (the user was
    // charged); create it at 0 defensively. Adding credits can NEVER violate the
    // solvency CHECK (balance rises, held unchanged), so no balance guard is
    // needed — but the UPDATE must hit exactly one row.
    tx.insert(creditWallets)
      .values({ userId: input.userId, balance: 0, held: 0, version: 0, updatedAt: now })
      .onConflictDoNothing()
      .run()
    const upd = tx
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${input.credits}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(eq(creditWallets.userId, input.userId))
      .run()
    if (upd.changes !== 1) {
      throw new Error(`refund: wallet UPDATE matched ${upd.changes} rows for user ${input.userId}`)
    }

    const { balance: balanceAfter } = getWallet(input.userId, tx as unknown as Db)
    const ledgerId = randomUUID()
    tx.insert(usageLedger)
      .values({
        id: ledgerId,
        userId: input.userId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        requestId: input.requestId,
        ...(input.holdId !== undefined ? { holdId: input.holdId } : {}),
        idempotencyKey: input.idempotencyKey,
        kind: input.kind ?? 'refund',
        reason: input.reason,
        ...(input.costMicroUsd !== undefined ? { costMicroUsd: input.costMicroUsd } : {}),
        creditsCharged: -input.credits, // NEGATIVE = credit returned (double-entry)
        balanceAfter,
        createdAt: now,
      })
      .run()

    return { ok: true, ledgerId, creditsRefunded: input.credits, balanceAfter, reused: false }
  })
}

/**
 * Crash-recovery janitor: release 'active' holds whose expiry has passed — a
 * process crash between hold and settle would otherwise strand the reserved
 * credits forever (presenting to the user as a stuck balance). Returns the
 * number released.
 */
export function reapExpiredHolds(db: Db = getDb(), now: number = nowSec()): number {
  const stale = db
    .select({ id: creditHolds.id })
    .from(creditHolds)
    .where(and(eq(creditHolds.status, 'active'), lt(creditHolds.expiresAt, now)))
    .all()
  let released = 0
  for (const { id } of stale) {
    if (releaseHold(id, db).released) released++
  }
  return released
}
