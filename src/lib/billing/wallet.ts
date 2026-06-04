import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { creditHolds, creditPurchases, creditWallets, usageLedger } from '@/lib/db/schema'

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

export type HoldResult =
  | { ok: true; holdId: string }
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
      .select({ id: creditHolds.id })
      .from(creditHolds)
      .where(eq(creditHolds.idempotencyKey, input.idempotencyKey))
      .get()
    if (existing) return { ok: true, holdId: existing.id }

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
    return { ok: true, holdId }
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

    tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} - ${debit}`,
        held: sql`${creditWallets.held} - ${hold.credits}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(eq(creditWallets.userId, hold.userId))
      .run()

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
): { applied: boolean; balanceAfter: number } {
  if (!Number.isInteger(input.creditsDelta)) {
    throw new Error(`wallet: creditsDelta must be an integer (got ${input.creditsDelta})`)
  }
  const now = nowSec()
  return db.transaction((tx): { applied: boolean; balanceAfter: number } => {
    if (input.externalRef) {
      const dup = tx
        .select({ id: creditPurchases.id })
        .from(creditPurchases)
        .where(eq(creditPurchases.externalRef, input.externalRef))
        .get()
      if (dup) return { applied: false, balanceAfter: getWallet(input.userId, tx as unknown as Db).balance }
    }
    tx.insert(creditWallets)
      .values({ userId: input.userId, balance: 0, held: 0, version: 0, updatedAt: now })
      .onConflictDoNothing()
      .run()
    tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${input.creditsDelta}`,
        version: sql`${creditWallets.version} + 1`,
        updatedAt: now,
      })
      .where(eq(creditWallets.userId, input.userId))
      .run()
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
