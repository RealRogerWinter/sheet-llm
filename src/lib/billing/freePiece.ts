import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
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
 * RESERVE the one-time free piece PRE-DISPATCH (PR-7b-2c) — the atomic claim that
 * closes the TOCTOU window the consume-on-delivery design left open. Folds the
 * eligibility check INTO the claim: the guard-in-the-write (`email_verified = 1
 * AND free_full_piece_used_at IS NULL`) means a concurrent from-scratch burst has
 * exactly ONE winner. Symmetric with the credit hold's `placeHold`.
 *
 * Returns the per-claim OWNER TOKEN (a fresh UUID, also written to the row) iff
 * THIS call claimed the grant, else `null` (ineligible / already taken). The
 * caller then OWNS the claim and MUST pass the token to {@link releaseFreePiece}
 * on any non-delivery exit (mirrors releaseHold). PR-13 added the token so a
 * late/duplicate release can only clear the claim it owns — never a different
 * request's fresh re-claim.
 */
export function reserveFreePiece(userId: string, db: Db = getDb()): string | null {
  const token = randomUUID()
  const res = db
    .update(users)
    .set({ freeFullPieceUsedAt: nowSec(), freeFullPieceClaimToken: token })
    .where(
      and(eq(users.id, userId), eq(users.emailVerified, 1), isNull(users.freeFullPieceUsedAt)),
    )
    .run()
  return res.changes === 1 ? token : null
}

/**
 * RELEASE a reservation that did NOT result in a delivered piece — un-claim it
 * (`free_full_piece_used_at` + token back to NULL) so a retry is eligible again.
 * Symmetric with releaseHold; the credit-hold reaper has no equivalent here, so a
 * process crash between reserve and release strands the grant as consumed (a
 * low-impact, one-time-per-verified-account regression vs. the cost-leak this
 * closes).
 *
 * SCOPED to the owning `token` (PR-13): the WHERE matches only the row still
 * holding THIS claim's token, so a late or duplicate release — or any future 2nd
 * release path / reaper — is a clean no-op against a row that has since been
 * re-claimed by a concurrent request (which now holds a different token). Returns
 * true iff this call cleared its own claim.
 */
export function releaseFreePiece(userId: string, token: string, db: Db = getDb()): boolean {
  const res = db
    .update(users)
    .set({ freeFullPieceUsedAt: null, freeFullPieceClaimToken: null })
    .where(and(eq(users.id, userId), eq(users.freeFullPieceClaimToken, token)))
    .run()
  return res.changes === 1
}
