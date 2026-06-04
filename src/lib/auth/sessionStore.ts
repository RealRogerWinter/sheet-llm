import { cookies } from 'next/headers'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { authSessions } from '@/lib/db/schema'

/**
 * DB-backed, REVOCABLE login sessions (`sl_sess`) — distinct from the anonymous
 * stateless `sl_uid` JWT in `session.ts`. The cookie carries an opaque 32-byte
 * random token; only its SHA-256 hash is stored in `auth_sessions`, so a DB read
 * cannot replay a session. Logout/logout-all/reset SET `revoked_at` (the row is
 * kept for audit; the janitor GCs it later — PR-9). The DB row is authoritative;
 * the cookie's max-age is always <= the row's absolute expiry.
 *
 * PR-2 builds + tests this core; the writers (login/logout/reset) land in PR-4/5.
 */

type Db = ReturnType<typeof getDb>

/** httpOnly opaque-token cookie for an authenticated (logged-in) session. */
const SESSION_COOKIE = 'sl_sess'
/**
 * Non-httpOnly sentinel so the client can answer "am I logged in?" without the
 * token. Distinct from `sl_present` (which tracks the anonymous `sl_uid`).
 */
const AUTH_PRESENT_COOKIE = 'sl_auth'

export const AUTH_SESSION_COOKIE_NAME = SESSION_COOKIE
export const AUTH_PRESENT_COOKIE_NAME = AUTH_PRESENT_COOKIE

// Expiry policy (seconds). remember-me OFF clamps the ABSOLUTE expiry to hours
// so a browser session-restore can't resurrect a long-lived session.
const ABSOLUTE_TTL_S = 90 * 24 * 60 * 60 // 90 days
const ABSOLUTE_TTL_EPHEMERAL_S = 12 * 60 * 60 // 12 hours (remember-me off)
const IDLE_TTL_S = 14 * 24 * 60 * 60 // 14 days sliding
// Only slide `idle_expires_at` when it's been > this since `last_used_at` — caps
// write amplification on single-writer SQLite (≈1 UPDATE/hour, not per request).
const IDLE_BUMP_THRESHOLD_S = 60 * 60

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Only SHA-256(token) is stored, so a DB leak can't be replayed as a session. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

function cookieSecure(): boolean {
  // Secure by default; opt out only for localhost HTTP dev (mirrors session.ts).
  return process.env.SL_INSECURE_COOKIE_OK !== '1'
}

export interface CreateAuthSessionInput {
  /** Default true (90-day absolute). false → a short-lived ephemeral session. */
  rememberMe?: boolean
  userAgent?: string | null
  /** Truncated to /24 (IPv4) or /64 (IPv6) by the caller. */
  ip?: string | null
}

/**
 * Mint a DB-backed auth session for `userId` and set the `sl_sess` (httpOnly) +
 * `sl_auth` (sentinel) cookies. Returns the new `auth_sessions` row id.
 */
export async function createAuthSession(
  userId: string,
  input: CreateAuthSessionInput = {},
  database?: Db,
): Promise<{ id: string }> {
  const db = database ?? getDb()
  const store = await cookies()
  const token = generateToken()
  const now = nowSeconds()
  const absoluteTtl =
    input.rememberMe === false ? ABSOLUTE_TTL_EPHEMERAL_S : ABSOLUTE_TTL_S
  const expiresAt = now + absoluteTtl
  const idleExpiresAt = Math.min(now + IDLE_TTL_S, expiresAt)
  const id = randomUUID()
  await db.insert(authSessions).values({
    id,
    userId,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt,
    idleExpiresAt,
    lastUsedAt: now,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  })
  const secure = cookieSecure()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: absoluteTtl,
  })
  store.set(AUTH_PRESENT_COOKIE, '1', {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: absoluteTtl,
  })
  return { id }
}

/**
 * Resolve + validate the current `sl_sess` cookie. Returns the owning `userId`,
 * or null on: no cookie / unknown token / revoked / absolutely-expired /
 * idle-expired. On a hit, slides idle expiry (throttled) via a GUARDED UPDATE
 * that can never resurrect a revoked or absolutely-expired row.
 */
export async function verifyAuthSession(
  database?: Db,
): Promise<{ userId: string } | null> {
  const db = database ?? getDb()
  const store = await cookies()
  const cookie = store.get(SESSION_COOKIE)
  if (!cookie?.value) return null
  const now = nowSeconds()
  const row = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      idleExpiresAt: authSessions.idleExpiresAt,
      lastUsedAt: authSessions.lastUsedAt,
      revokedAt: authSessions.revokedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.tokenHash, hashToken(cookie.value)))
    .limit(1)
    .get()
  if (!row) return null
  if (row.revokedAt !== null) return null
  if (row.expiresAt <= now || row.idleExpiresAt <= now) return null
  if (now - row.lastUsedAt > IDLE_BUMP_THRESHOLD_S) {
    const nextIdle = Math.min(now + IDLE_TTL_S, row.expiresAt)
    await db
      .update(authSessions)
      .set({ lastUsedAt: now, idleExpiresAt: nextIdle })
      .where(
        and(
          eq(authSessions.id, row.id),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
  }
  return { userId: row.userId }
}

/** Clear the `sl_sess` + `sl_auth` cookies (no DB change). */
export async function clearAuthSessionCookies(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
  store.delete(AUTH_PRESENT_COOKIE)
}

/**
 * Revoke the CURRENT request's auth session (logout): SET `revoked_at` on the
 * row matching the `sl_sess` cookie, then clear the cookies. Revoke (not DELETE)
 * keeps the row for audit; the janitor GCs it later (PR-9).
 */
export async function revokeCurrentAuthSession(database?: Db): Promise<void> {
  const db = database ?? getDb()
  const store = await cookies()
  const cookie = store.get(SESSION_COOKIE)
  if (cookie?.value) {
    await db
      .update(authSessions)
      .set({ revokedAt: nowSeconds() })
      .where(
        and(
          eq(authSessions.tokenHash, hashToken(cookie.value)),
          isNull(authSessions.revokedAt),
        ),
      )
  }
  await clearAuthSessionCookies()
}

/**
 * Revoke ALL of a user's live auth sessions ("log out everywhere" / on password
 * reset). Returns the number of rows revoked.
 */
export async function revokeAllAuthSessions(
  userId: string,
  database?: Db,
): Promise<number> {
  const db = database ?? getDb()
  const revoked = await db
    .update(authSessions)
    .set({ revokedAt: nowSeconds() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id })
  return revoked.length
}

export interface AuthSessionSummary {
  id: string
  createdAt: number
  lastUsedAt: number
  userAgent: string | null
  ip: string | null
  /** True for the session backing the CURRENT request's `sl_sess` cookie. */
  current: boolean
}

/**
 * List a user's LIVE sessions (unrevoked + unexpired) for the account-settings
 * "active sessions" list, flagging the current one. The opaque token is never
 * exposed — only its presence is used to mark `current`.
 */
export async function listAuthSessions(
  userId: string,
  database?: Db,
): Promise<AuthSessionSummary[]> {
  const db = database ?? getDb()
  const store = await cookies()
  const cookie = store.get(SESSION_COOKIE)
  const currentHash = cookie?.value ? hashToken(cookie.value) : null
  const now = nowSeconds()
  const rows = await db
    .select({
      id: authSessions.id,
      tokenHash: authSessions.tokenHash,
      createdAt: authSessions.createdAt,
      lastUsedAt: authSessions.lastUsedAt,
      userAgent: authSessions.userAgent,
      ip: authSessions.ip,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
        // Match verifyAuthSession's liveness: an idle-expired session can't
        // authenticate, so it must not appear as "active" either.
        gt(authSessions.idleExpiresAt, now),
      ),
    )
    .all()
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    userAgent: r.userAgent,
    ip: r.ip,
    current: currentHash !== null && r.tokenHash === currentHash,
  }))
}

/**
 * Revoke ONE session by id — only if it belongs to `userId` (so a user can't
 * revoke another account's session). Returns true if a live row was revoked.
 */
export async function revokeAuthSessionById(
  userId: string,
  id: string,
  database?: Db,
): Promise<boolean> {
  const db = database ?? getDb()
  const revoked = await db
    .update(authSessions)
    .set({ revokedAt: nowSeconds() })
    .where(
      and(
        eq(authSessions.id, id),
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
      ),
    )
    .returning({ id: authSessions.id })
  return revoked.length > 0
}
