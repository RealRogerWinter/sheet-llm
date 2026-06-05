import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'

/**
 * FREE FULL PIECE — a one-time, per-VERIFIED-account grant of ONE full
 * (pro-scope) generation, free and OFF the money path (no hold / settle /
 * wallet). It is a charge-SKIP, NOT a credit grant: granting credits would open
 * refund-farming (red-team #7), so this never touches the wallet. A one-time CAC
 * lever (~$0.16) to let a verified user taste the full product before paying.
 *
 * Eligibility is keyed on the VERIFIED account id (email_verified = 1) so it
 * can't be farmed by anonymous identities, and the route additionally restricts
 * it to FROM-SCRATCH requests (no existing score → always a generation, never a
 * free edit/converse). DARK with the paid layer (the route gates on
 * isPaidGenerationEnabled before calling these).
 */

type Db = ReturnType<typeof getDb>

const nowSec = (): number => Math.floor(Date.now() / 1000)

/**
 * Is this account eligible for its one-time free full piece — a VERIFIED account
 * (email_verified = 1) that has never consumed it (free_full_piece_used_at IS
 * NULL)? Pure read; the route layers on `!existingScore` + the flag.
 */
export function isFreePieceEligible(userId: string, db: Db = getDb()): boolean {
  const row = db
    .select({ emailVerified: users.emailVerified, usedAt: users.freeFullPieceUsedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .get()
  return !!row && row.emailVerified === 1 && row.usedAt == null
}

/**
 * Consume the one-time free full piece. Idempotent guard-in-the-write: the
 * `WHERE free_full_piece_used_at IS NULL` clause means only the FIRST call sets
 * it, so a retry / concurrent request can't grant a second free piece. Returns
 * true iff THIS call consumed it. Call only on a successful delivery so a failed
 * generation doesn't burn the grant.
 */
export function consumeFreePiece(userId: string, db: Db = getDb()): boolean {
  const res = db
    .update(users)
    .set({ freeFullPieceUsedAt: nowSec() })
    .where(and(eq(users.id, userId), isNull(users.freeFullPieceUsedAt)))
    .run()
  return res.changes === 1
}

/**
 * RESERVE the one-time free piece PRE-DISPATCH (PR-7b-2c) — the atomic claim that
 * closes the TOCTOU window the consume-on-delivery design left open. Folds the
 * eligibility check INTO the claim: the guard-in-the-write (`email_verified = 1
 * AND free_full_piece_used_at IS NULL`) means a concurrent from-scratch burst has
 * exactly ONE winner (returns true); the losers see it taken and fall to the paid
 * path. Symmetric with the credit hold's `placeHold`. Returns true iff THIS call
 * claimed the grant — the caller then OWNS it and MUST {@link releaseFreePiece} on
 * any non-delivery exit (mirrors releaseHold).
 */
export function reserveFreePiece(userId: string, db: Db = getDb()): boolean {
  const res = db
    .update(users)
    .set({ freeFullPieceUsedAt: nowSec() })
    .where(
      and(eq(users.id, userId), eq(users.emailVerified, 1), isNull(users.freeFullPieceUsedAt)),
    )
    .run()
  return res.changes === 1
}

/**
 * RELEASE a reservation that did NOT result in a delivered piece — un-claim it
 * (`free_full_piece_used_at` back to NULL) so a retry is eligible again. Symmetric
 * with releaseHold; the credit-hold reaper has no equivalent here, so a process
 * crash between reserve and release strands the grant as consumed (a low-impact,
 * one-time-per-verified-account regression vs. the cost-leak this closes). The
 * `IS NOT NULL` guard makes a redundant call a clean no-op. The atomic reserve
 * serializes ownership, so only THIS request's claim is ever cleared here.
 */
export function releaseFreePiece(userId: string, db: Db = getDb()): boolean {
  const res = db
    .update(users)
    .set({ freeFullPieceUsedAt: null })
    .where(and(eq(users.id, userId), isNotNull(users.freeFullPieceUsedAt)))
    .run()
  return res.changes === 1
}
