import { errors as joseErrors, jwtVerify, SignJWT } from 'jose'
import { nanoid } from 'nanoid'

/**
 * Recovery tokens are SEPARATE from the session cookie JWT and use a
 * SEPARATE signing key (`RECOVERY_SECRET`). Reason: the cookie JWT
 * stays `httpOnly` for its entire lifetime; the recovery token is
 * intentionally exposed to client JS (it lives in `localStorage` so
 * the user can recover after Safari ITP eats their cookie). If the
 * two shared a key, an XSS payload that exfiltrates the recovery
 * token would also be a session-cookie forgery oracle.
 *
 * With separate keys, an XSS still steals the recovery token (one
 * forgery), but `RECOVERY_SECRET` can be rotated independently —
 * killing every backup token in one move without invalidating any
 * active session cookie.
 *
 * Single-use enforcement: each token carries a random `nonce`. The
 * server tracks the LAST CONSUMED nonce per user in
 * `users.last_recovery_nonce`. Restore rejects any token whose nonce
 * already appears there. After a successful restore, we mint a fresh
 * token with a new nonce; the client overwrites its localStorage
 * backup with that one.
 *
 * kid: included in the JWT header so a future multi-key rotation can
 * iterate the candidate set without breaking active backups.
 */

const ALG = 'HS256'
const KID = process.env.RECOVERY_KEY_KID ?? 'r1'
const MAX_AGE_S = 60 * 60 * 24 * 365 // 1 year, matching the session cookie

function getRecoverySecret(): Uint8Array {
  const s = process.env.RECOVERY_SECRET
  if (!s) {
    throw new Error(
      '[recovery] RECOVERY_SECRET env var is missing. ' +
        "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`. " +
        'MUST be different from SESSION_SECRET so the two can be rotated independently.',
    )
  }
  const bytes = new TextEncoder().encode(s)
  if (bytes.byteLength < 32) {
    throw new Error(
      `[recovery] RECOVERY_SECRET is ${bytes.byteLength} bytes; HS256 requires >=32. ` +
        'See SESSION_SECRET docs in .env.example for generation.',
    )
  }
  return bytes
}

export type RecoveryClaims = {
  /** users.id of the account being recovered. */
  sub: string
  /** Random per-token nonce — used to enforce single-use. */
  nonce: string
  /** Key id; supports future rotation without invalidating active tokens. */
  kid: string
}

/**
 * Mint a fresh recovery token for `userId`. The nonce is brand-new
 * — call `markNonceConsumed` after a successful restore so the same
 * token can't be replayed.
 */
export async function signRecoveryToken(userId: string): Promise<{
  token: string
  nonce: string
}> {
  const nonce = nanoid(24)
  const token = await new SignJWT({ nonce })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(getRecoverySecret())
  return { token, nonce }
}

export type VerifyResult =
  | { ok: true; sub: string; nonce: string }
  | { ok: false; reason: 'bad_signature' | 'expired' | 'malformed' }

/**
 * Verify a recovery token. Returns the `sub` + `nonce` on success so
 * the caller can check `nonce !== users.last_recovery_nonce` (single-
 * use enforcement) before treating the restore as valid.
 *
 * Does NOT touch the DB. Pure crypto + claim shape validation.
 */
export async function verifyRecoveryToken(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, getRecoverySecret(), {
      algorithms: [ALG],
      clockTolerance: 30, // tolerate small clock skew across instances
    })
    const sub = typeof payload.sub === 'string' ? payload.sub : ''
    const nonce =
      'nonce' in payload && typeof payload.nonce === 'string' ? payload.nonce : ''
    if (!sub || !nonce) return { ok: false, reason: 'malformed' }
    return { ok: true, sub, nonce }
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired' }
    }
    if (err instanceof joseErrors.JOSEError) {
      return { ok: false, reason: 'bad_signature' }
    }
    throw err
  }
}

/** The header name client backup writes from response → localStorage. */
export const RECOVERY_HEADER = 'X-Session-Recovery'

/** The localStorage key for the client backup token. */
export const RECOVERY_STORAGE_KEY = 'sheet-llm:recovery'
