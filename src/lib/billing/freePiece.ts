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
