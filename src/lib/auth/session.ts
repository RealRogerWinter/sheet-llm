import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { signRecoveryToken } from '@/lib/auth/recovery'
import { verifyAuthSession } from '@/lib/auth/sessionStore'

const COOKIE_NAME = 'sl_uid'
// Non-httpOnly companion to sl_uid. Set/cleared in lockstep with the
// session cookie. The client-side recovery flow reads document.cookie
// for this sentinel to answer "do we have a session?" without needing
// to expose the JWT to JS. Value is opaque '1' — only presence matters.
const SESSION_PRESENT_COOKIE = 'sl_present'
const ALG = 'HS256'
const KID = process.env.SESSION_KEY_KID ?? 's1'
const MAX_AGE_S = 60 * 60 * 24 * 365 // 1 year
const MIN_SECRET_BYTES = 32 // RFC 7518 §3.2: HS256 keys must be ≥256 bits
const CLOCK_TOLERANCE_S = 30 // soak up multi-instance NTP drift on jwtVerify

export const SESSION_PRESENT_COOKIE_NAME = SESSION_PRESENT_COOKIE

type Db = ReturnType<typeof getDb>

function getSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET
  if (!s) {
    throw new Error(
      '[auth] SESSION_SECRET env var is missing. ' +
        "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`",
    )
  }
  const bytes = new TextEncoder().encode(s)
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `[auth] SESSION_SECRET is ${bytes.byteLength} bytes; HS256 requires ≥${MIN_SECRET_BYTES} per RFC 7518. ` +
        "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`",
    )
  }
  return bytes
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function signToken(userId: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(getSecret())
}

/**
 * Set the session cookie on the response. Shared between createNewUser
 * (anon mint) and the restore endpoint (cookie re-issue after recovery).
 */
async function setSessionCookie(
  store: Awaited<ReturnType<typeof cookies>>,
  userId: string,
): Promise<string> {
  const token = await signToken(userId)
  // Default-safe: Secure unless explicitly opted out for localhost dev.
  const secure = process.env.SL_INSECURE_COOKIE_OK !== '1'
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_S,
  })
  // Set the JS-readable presence sentinel in lockstep. The client's
  // bootRestoreIfNeeded reads this to skip recovery when a session
  // already exists — without it, every page load triggers a restore
  // (whose response would mint a fresh recovery token, the interceptor
  // would stash it, the boot would reload, and the loop would chew
  // through the rate-limit budget).
  store.set(SESSION_PRESENT_COOKIE, '1', {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_S,
  })
  return token
}

/**
 * Result of `getOrCreateUserId`. `recoveryToken` is populated ONLY when
 * a fresh session cookie was minted (new anon user, cookie-invalid, or
 * user-row-GC'd retry). On the normal returning-user path it's
 * undefined — the client already has a backup in localStorage from the
 * mint that created it.
 *
 * Route handlers attach the token to the response via
 * `attachRecoveryHeader(res, sessionResult)`. The client-side
 * `clientBackup.ts` interceptor reads the header into localStorage.
 */
export interface SessionResult {
  userId: string
  recoveryToken?: string
}

/**
 * @internal Anonymous-identity primitive that does NOT claim-gate. Route
 * handlers MUST use `getRequestUser` instead — honoring a stale `sl_uid` for a
 * CLAIMED account here would reopen the recovery-takeover door. Retained for the
 * anon mint path + existing tests; `identityResolverGuard.test.ts` bans it from
 * `src/` outside this file.
 *
 * Resolve the current user, creating a new anonymous account + cookie if needed.
 *
 * MUST be called from a Route Handler or Server Action, NOT from a Server
 * Component — Next 16's `cookies().set` throws CookiesOutsideOfRequestHandlerError
 * in read-only render contexts (and is a no-op once the response stream is
 * flushed, so call this before SSE starts).
 *
 * The `database` arg exists for tests; production code calls with no
 * argument to use the lazy singleton.
 */
export async function getOrCreateUserId(database?: Db): Promise<SessionResult> {
  const db: Db = database ?? getDb()
  const store = await cookies()
  const existing = store.get(COOKIE_NAME)
  if (existing?.value) {
    try {
      const { payload } = await jwtVerify(existing.value, getSecret(), {
        algorithms: [ALG],
        clockTolerance: CLOCK_TOLERANCE_S,
      })
      const userId = typeof payload.sub === 'string' ? payload.sub : ''
      if (userId) {
        const stillExists = await touchLastSeen(db, userId)
        if (stillExists) return { userId }
        // User row was deleted (e.g., dormant-user GC); fall through and
        // recreate. The new userId is unrelated to the old one — by design,
        // since GC implies the cookie was already abandoned.
      }
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) {
        // Any jose-level failure (expired, malformed, wrong signature,
        // unsupported alg, etc.) → mint a new identity below.
      } else {
        throw err
      }
    }
  }
  return await createNewUser(db, store)
}

async function createNewUser(
  database: Db,
  store: Awaited<ReturnType<typeof cookies>>,
): Promise<SessionResult> {
  const userId = crypto.randomUUID()
  // Sign FIRST so a misconfigured SESSION_SECRET surfaces as an error
  // BEFORE we commit a row that no cookie will ever map to. (Without this,
  // every retry under a bad secret would leak another orphan user row.)
  await signToken(userId)
  // Same belt-and-suspenders check for RECOVERY_SECRET — surface
  // misconfiguration on first request rather than at first restore attempt.
  const { token: recoveryToken } = await signRecoveryToken(userId)
  const ts = nowSeconds()
  await database.insert(users).values({
    id: userId,
    createdAt: ts,
    lastSeenAt: ts,
  })
  await setSessionCookie(store, userId)
  return { userId, recoveryToken }
}

/**
 * Used by `/api/auth/restore` to re-issue the session cookie for an
 * already-verified user. Mints a fresh recovery token too (rolling
 * refresh) so each restore extends the recovery lifetime.
 *
 * Does NOT touch `users.last_recovery_nonce` — the route handler must
 * mark the consumed nonce there to enforce single-use.
 */
export async function reissueSessionForRecovery(
  userId: string,
): Promise<{ recoveryToken: string }> {
  const store = await cookies()
  await setSessionCookie(store, userId)
  const { token } = await signRecoveryToken(userId)
  return { recoveryToken: token }
}

/**
 * Clear both the session cookie AND the presence sentinel. Used by
 * /api/me/delete so the next request mints a fresh anonymous identity
 * instead of restoring the just-deleted user, AND so the client's
 * `hasSessionCookie` check correctly reports "no session" after delete.
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.delete(COOKIE_NAME)
  store.delete(SESSION_PRESENT_COOKIE)
}

/**
 * @internal Read-only anon primitive that does NOT claim-gate; routes MUST use
 * `getExistingRequestUser`. Retained for tests (see the guard test).
 *
 * Read-only variant of `getOrCreateUserId` — verifies an existing cookie
 * and returns the userId, or returns null when no valid session exists.
 * Never mints a new identity.
 *
 * Used by routes where minting-on-the-spot is semantically wrong:
 *   - `/api/me/export` (don't dump an empty just-minted phantom account)
 *   - `/api/me/delete` (don't delete a just-minted phantom while the
 *     real account sits untouched in the DB)
 *
 * These routes must `return errorResponse(..., 401, ...)` when this
 * returns null.
 */
export async function getExistingUserId(
  database?: Db,
): Promise<{ userId: string } | null> {
  const db: Db = database ?? getDb()
  const store = await cookies()
  const existing = store.get(COOKIE_NAME)
  if (!existing?.value) return null
  try {
    const { payload } = await jwtVerify(existing.value, getSecret(), {
      algorithms: [ALG],
      clockTolerance: CLOCK_TOLERANCE_S,
    })
    const userId = typeof payload.sub === 'string' ? payload.sub : ''
    if (!userId) return null
    const stillExists = await touchLastSeen(db, userId)
    if (!stillExists) return null
    return { userId }
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) return null
    throw err
  }
}

/**
 * Bump `users.last_seen_at`. Returns false if the user row no longer exists
 * (caller should treat as "cookie outlived its user" and mint a new one).
 */
async function touchLastSeen(database: Db, userId: string): Promise<boolean> {
  const ts = nowSeconds()
  const result = await database
    .update(users)
    .set({ lastSeenAt: ts })
    .where(eq(users.id, userId))
    .returning({ id: users.id })
  return result.length > 0
}

/**
 * The resolved identity for a request. `recoveryToken` is present ONLY when a
 * fresh anonymous identity was just minted (so the route attaches the recovery
 * header); it is NEVER set for an authenticated request, which suppresses the
 * recovery-token machinery for logged-in accounts.
 */
export interface RequestUser {
  userId: string
  /** true when resolved via a DB-backed sl_sess (a real logged-in account). */
  authenticated: boolean
  recoveryToken?: string
}

/**
 * Is `userId` a CLAIMED account (has email / password / OAuth)? A stale `sl_uid`
 * for a claimed account must NOT authenticate it: `sl_uid` is an unrevocable
 * 1-year bearer JWT, so honoring it would be a passwordless login. Returns
 * existence too, so the caller can distinguish "GC'd" from "claimed".
 */
async function getClaimStatus(
  db: Db,
  userId: string,
): Promise<{ exists: boolean; claimed: boolean }> {
  const row = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      claimedAt: users.claimedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .get()
  if (!row) return { exists: false, claimed: false }
  return {
    exists: true,
    claimed:
      row.email !== null || row.passwordHash !== null || row.claimedAt !== null,
  }
}

/**
 * THE identity entry point for route handlers (replaces `getOrCreateUserId`).
 * Resolution order:
 *   1. A valid DB-backed `sl_sess` → the authenticated account (revocable).
 *      `sl_uid` is ignored and NOT minted; no recovery token is emitted.
 *   2. Else a valid `sl_uid` for an ANONYMOUS (unclaimed) user → that anon id.
 *   3. Else (no/invalid `sl_uid`, a GC'd user, OR a `sl_uid` pointing at a
 *      CLAIMED account) → mint a fresh anonymous identity. A stale `sl_uid` for a
 *      claimed account is REFUSED here so it can't passwordlessly authenticate
 *      the account; the browser becomes a clean anonymous visitor and must log in.
 *
 * MUST be called from a Route Handler / Server Action (it may set cookies). The
 * `database` arg exists for tests; production passes nothing.
 */
export async function getRequestUser(database?: Db): Promise<RequestUser> {
  const db: Db = database ?? getDb()
  const authed = await verifyAuthSession(db)
  if (authed) return { userId: authed.userId, authenticated: true }

  const store = await cookies()
  const existing = store.get(COOKIE_NAME)
  if (existing?.value) {
    try {
      const { payload } = await jwtVerify(existing.value, getSecret(), {
        algorithms: [ALG],
        clockTolerance: CLOCK_TOLERANCE_S,
      })
      const userId = typeof payload.sub === 'string' ? payload.sub : ''
      if (userId) {
        const status = await getClaimStatus(db, userId)
        if (status.exists && !status.claimed) {
          await touchLastSeen(db, userId)
          return { userId, authenticated: false }
        }
        // claimed account (refuse sl_uid) OR GC'd user → fall through to mint.
      }
    } catch (err) {
      if (!(err instanceof joseErrors.JOSEError)) throw err
      // jose-level failure (expired/malformed/wrong sig) → mint below.
    }
  }
  const minted = await createNewUser(db, store)
  return {
    userId: minted.userId,
    authenticated: false,
    recoveryToken: minted.recoveryToken,
  }
}

/**
 * Read-only resolver (NEVER mints) — the get-only counterpart of
 * `getRequestUser`, for routes where minting-on-the-spot is wrong
 * (`/api/me/export`, `/api/me/delete`). Returns null when there's no valid
 * session, INCLUDING a `sl_uid` that points at a claimed account (must log in).
 */
export async function getExistingRequestUser(
  database?: Db,
): Promise<{ userId: string; authenticated: boolean } | null> {
  const db: Db = database ?? getDb()
  const authed = await verifyAuthSession(db)
  if (authed) return { userId: authed.userId, authenticated: true }
  const store = await cookies()
  const existing = store.get(COOKIE_NAME)
  if (!existing?.value) return null
  try {
    const { payload } = await jwtVerify(existing.value, getSecret(), {
      algorithms: [ALG],
      clockTolerance: CLOCK_TOLERANCE_S,
    })
    const userId = typeof payload.sub === 'string' ? payload.sub : ''
    if (!userId) return null
    const status = await getClaimStatus(db, userId)
    if (!status.exists || status.claimed) return null
    await touchLastSeen(db, userId)
    return { userId, authenticated: false }
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) return null
    throw err
  }
}

/** Test-only: read the cookie name so mocks can target it precisely. */
export const __TEST_COOKIE_NAME = COOKIE_NAME
