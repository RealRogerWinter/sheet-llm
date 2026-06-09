import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { clearSessionCookie, readAnonCookieIdentity } from '@/lib/auth/session'

/**
 * Migrate the sessions/scores created under the browser's pre-login ANONYMOUS
 * identity onto the just-authenticated account, returning the number of sessions
 * moved. Shared by every login path so anon work is never stranded (SHE-9):
 *   - POST /api/auth/adopt-anon-work (password-login "keep my work")
 *   - the OAuth callback (full-page redirect, bypasses the modal)
 *
 * SECURITY: the anon userId is read SERVER-SIDE from the verified `sl_uid` cookie
 * (`readAnonCookieIdentity`), NEVER from client input — so a caller can't migrate
 * an arbitrary user's sessions (no IDOR). The TARGET is strictly `accountUserId`,
 * which callers must derive from the authenticated session they just established.
 * Idempotent / best-effort: returns 0 (no-op) when there's no anon cookie, the
 * identity is GC'd or already CLAIMED, or it already IS the account (signup /
 * OAuth-claim-in-place reuse the same userId). Only UNCLAIMED, distinct anon
 * identities are adopted, and ONLY the `sessions` table moves — IP/credit/quota
 * rows stay keyed to their original owner. On a real migration the absorbed
 * `sl_uid` is cleared so it can't be double-adopted.
 */
export async function adoptAnonWorkInto(accountUserId: string): Promise<number> {
  const db = getDb()
  const anon = await readAnonCookieIdentity(db)
  if (!anon || !anon.exists || anon.claimed || anon.userId === accountUserId) {
    return 0
  }

  const moved = await db
    .update(sessions)
    .set({ userId: accountUserId })
    .where(and(eq(sessions.userId, anon.userId), isNull(sessions.deletedAt)))
    .returning({ id: sessions.id })

  // Consume the absorbed anonymous identity so it can't be double-adopted and the
  // browser is cleanly the account from here on.
  await clearSessionCookie()

  return moved.length
}
