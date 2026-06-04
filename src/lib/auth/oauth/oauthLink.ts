import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { oauthAccounts, users } from '@/lib/db/schema'
import { findUserByEmail, isUniqueViolation, normalizeEmail } from '@/lib/auth/account'
import type { OAuthUser } from './oauthUser'

type Db = ReturnType<typeof getDb>

export type OAuthLinkOutcome =
  | { ok: true; userId: string; kind: 'login' | 'linked' | 'created' }
  | {
      ok: false
      error: 'email_unverified' | 'email_taken_unverified' | 'oauth_already_linked' | 'claim_conflict'
    }

class ClaimConflictError extends Error {}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * The OAuth account-resolution rules — the security centerpiece of PR-6.
 * Precedence:
 *   1. Provider account already linked  → log in that user.
 *   2. Caller is logged in              → LINK the provider identity to the
 *                                          current (authenticated) account.
 *   3. Anonymous caller — requires a VERIFIED provider email, then by that email:
 *      a. a VERIFIED local account  → link (verified <-> verified).
 *      b. an UNVERIFIED local account → REFUSE (`email_taken_unverified`): never
 *         silently take over an account whose email isn't proven — that is the
 *         pre-hijacking vector. The owner verifies / resets first (interstitial).
 *      c. no local account          → CLAIM the current anonymous identity, with
 *         email + email_verified + claimed_at set ATOMICALLY alongside the
 *         oauth_accounts insert (one transaction).
 */
export async function resolveOAuthLogin(
  oauthUser: OAuthUser,
  current: { userId: string; authenticated: boolean },
  database?: Db,
): Promise<OAuthLinkOutcome> {
  const db = database ?? getDb()
  const now = nowSeconds()

  // 1. Already linked → login.
  const existing = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, oauthUser.provider),
        eq(oauthAccounts.providerAccountId, oauthUser.providerAccountId),
      ),
    )
    .limit(1)
    .get()
  if (existing) return { ok: true, userId: existing.userId, kind: 'login' }

  // 2. Logged in → link the provider identity to the current account.
  if (current.authenticated) {
    return insertLink(db, current.userId, oauthUser, now)
  }

  // 3. Anonymous → need a VERIFIED provider email to safely link/create.
  if (!oauthUser.email || !oauthUser.emailVerified) {
    return { ok: false, error: 'email_unverified' }
  }
  const local = await findUserByEmail(oauthUser.email, db)
  if (local) {
    if (local.emailVerified === 1) {
      return insertLink(db, local.id, oauthUser, now) // verified <-> verified
    }
    return { ok: false, error: 'email_taken_unverified' } // never silently take over
  }

  // 3c. No local account with this email → claim the current anonymous identity.
  try {
    db.transaction((tx) => {
      const res = tx
        .update(users)
        .set({ email: normalizeEmail(oauthUser.email as string), emailVerified: 1, claimedAt: now })
        .where(
          and(
            eq(users.id, current.userId),
            isNull(users.email),
            isNull(users.passwordHash),
            isNull(users.claimedAt),
          ),
        )
        .run()
      if (res.changes === 0) throw new ClaimConflictError()
      tx.insert(oauthAccounts)
        .values({
          id: randomUUID(),
          userId: current.userId,
          provider: oauthUser.provider,
          providerAccountId: oauthUser.providerAccountId,
          createdAt: now,
        })
        .run()
    })
    return { ok: true, userId: current.userId, kind: 'created' }
  } catch (e) {
    if (e instanceof ClaimConflictError) return { ok: false, error: 'claim_conflict' }
    if (isUniqueViolation(e)) return { ok: false, error: 'oauth_already_linked' }
    throw e
  }
}

async function insertLink(
  db: Db,
  userId: string,
  oauthUser: OAuthUser,
  now: number,
): Promise<OAuthLinkOutcome> {
  try {
    await db.insert(oauthAccounts).values({
      id: randomUUID(),
      userId,
      provider: oauthUser.provider,
      providerAccountId: oauthUser.providerAccountId,
      createdAt: now,
    })
    return { ok: true, userId, kind: 'linked' }
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'oauth_already_linked' }
    throw e
  }
}
