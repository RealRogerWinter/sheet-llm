import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'

type Db = ReturnType<typeof getDb>

/**
 * Accounts feature flag — OFF by default. Every user-facing auth ROUTE 404s
 * until an operator flips `SL_ACCOUNTS_ENABLED`. (The security-load-bearing
 * schema + recovery/claim gate + resolver from PR-1/2 are ALWAYS live; only the
 * signup/login/etc. surface is gated.) Read fresh per request.
 */
export function isAccountsEnabled(): boolean {
  const v = process.env.SL_ACCOUNTS_ENABLED
  return v === '1' || v?.toLowerCase() === 'true'
}

/**
 * THE single normalization point for email (lowercase + trim). EVERY
 * signup/login/oauth/reset path funnels through this so the plain unique index
 * on `users.email` enforces case-insensitive uniqueness without an expression
 * index. (PR-2 review carry-forward.)
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface AccountRow {
  id: string
  email: string | null
  passwordHash: string | null
  emailVerified: number
  tier: string
  claimedAt: number | null
}

/** Look up an account by (normalized) email. */
export async function findUserByEmail(
  email: string,
  database?: Db,
): Promise<AccountRow | undefined> {
  const db = database ?? getDb()
  return db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified,
      tier: users.tier,
      claimedAt: users.claimedAt,
    })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1)
    .get()
}

/** Look up an account by its userId (for the authenticated /session read). */
export async function getAccountById(
  userId: string,
  database?: Db,
): Promise<AccountRow | undefined> {
  const db = database ?? getDb()
  return db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified,
      tier: users.tier,
      claimedAt: users.claimedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .get()
}

/** A better-sqlite3 UNIQUE-constraint violation (e.g. email already taken). */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const code = (e as { code?: string }).code
  const msg = (e as { message?: string }).message ?? ''
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE constraint failed/i.test(msg)
  )
}

/**
 * Claim the CURRENT anonymous `userId` as an email+password account IN PLACE
 * (all the user's existing sessions/scores carry over — no data move). Setting
 * `claimed_at` CLOSES the anonymous recovery path: both `/api/auth/restore` and
 * `getRequestUser` refuse a claimed row's `sl_uid` / recovery token.
 *
 * Returns 'ok', 'email_taken' (the email is used by a different account — unique
 * violation), or 'gone' (the user row vanished).
 */
export async function claimAccountWithPassword(
  userId: string,
  email: string,
  passwordHash: string,
  nowSec: number,
  database?: Db,
): Promise<'ok' | 'email_taken' | 'gone'> {
  const db = database ?? getDb()
  try {
    const res = await db
      .update(users)
      .set({ email: normalizeEmail(email), passwordHash, claimedAt: nowSec })
      .where(eq(users.id, userId))
      .returning({ id: users.id })
    return res.length > 0 ? 'ok' : 'gone'
  } catch (e) {
    if (isUniqueViolation(e)) return 'email_taken'
    throw e
  }
}
