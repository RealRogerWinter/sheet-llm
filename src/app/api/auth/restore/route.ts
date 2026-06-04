import { NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { verifyRecoveryToken, RECOVERY_HEADER } from '@/lib/auth/recovery'
import { reissueSessionForRecovery } from '@/lib/auth/session'
import {
  checkIp,
  checkSub,
  extractClientIp,
} from '@/lib/auth/restoreRateLimit'
import { checkSameOrigin, errorResponse } from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 4 * 1024

const BodySchema = z.object({
  token: z.string().min(20).max(4096),
})

/**
 * POST /api/auth/restore — re-issue the session cookie after cookie loss
 * (Safari ITP, browser cleared, cross-device transfer via shared link).
 *
 * Security model (cf. plan §"Recovery / `/api/auth/restore`"):
 *  - Recovery token is signed with RECOVERY_SECRET, a DIFFERENT key from
 *    SESSION_SECRET. An XSS that exfiltrates the recovery token cannot
 *    forge a session cookie; RECOVERY_SECRET can be rotated independently.
 *  - Single-use: each token carries a `nonce`. Server tracks the LAST
 *    CONSUMED nonce in users.last_recovery_nonce; restore rejects any
 *    token whose nonce already appears there. Replay of a stolen token
 *    requires beating the legitimate user to the restore call.
 *  - Rate-limited per-IP AND per-sub (post-verification). The per-sub
 *    bucket catches the replay-from-many-IPs case the per-IP bucket alone
 *    misses.
 *
 * Status codes:
 *   204 — cookie re-issued; new recovery token in `X-Session-Recovery`
 *   400 — malformed body
 *   401 — bad/expired token
 *   409 — token replayed (nonce already consumed), code `invalid_request`; OR
 *         the identity is now a claimed account (code `account_claimed`) — the
 *         anonymous recovery path is closed for it; sign in with the password /
 *         OAuth instead of restoring.
 *   410 — user row no longer exists (GC'd or /me/delete'd); client should
 *         clear localStorage backup, NOT silently mint a new identity here
 *   413 — body too large
 *   429 — rate limited
 */
export async function POST(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  // Per-IP rate-limit BEFORE doing any crypto / DB work — cheap DoS
  // protection. Forged tokens hit this gate without ever touching jose.
  const ip = extractClientIp(request)
  const ipCheck = checkIp(ip)
  if (!ipCheck.ok) {
    return new NextResponse(JSON.stringify({ code: 'rate_limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'Retry-After': String(ipCheck.retryAfterSec ?? 300),
      },
    })
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return errorResponse('invalid_request', 400, 'Could not read request body')
  }
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(JSON.parse(raw))
  } catch {
    return errorResponse('invalid_request', 400, 'Invalid request body')
  }

  // Verify the recovery JWT. Bad signature / expired / malformed → 401.
  // CRITICAL: must happen BEFORE the per-sub rate-limit check so forged
  // tokens never get to influence the sub bucket.
  const verified = await verifyRecoveryToken(body.token)
  if (!verified.ok) {
    return errorResponse(
      'invalid_request',
      401,
      verified.reason === 'expired' ? 'Recovery token expired' : 'Invalid recovery token',
    )
  }

  // Per-sub rate-limit — catches the "replay from a botnet" pattern that
  // per-IP alone misses (each IP gets its first hit free).
  const subCheck = checkSub(verified.sub)
  if (!subCheck.ok) {
    return new NextResponse(JSON.stringify({ code: 'rate_limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'Retry-After': String(subCheck.retryAfterSec ?? 300),
      },
    })
  }

  // Single-use compare-and-swap: UPDATE only succeeds when the nonce
  // hasn't been consumed before (predicate enforces it). On 0 rows,
  // we run one disambiguation SELECT to tell "user gone" (410) from
  // "nonce replayed" (409). The UPDATE is atomic, so two parallel
  // replays of the same token can only succeed for one side; the
  // other falls through to 409.
  const db = getDb()
  const updateResult = await db
    .update(users)
    .set({ lastRecoveryNonce: verified.nonce })
    .where(
      and(
        eq(users.id, verified.sub),
        // Recovery is for ANONYMOUS identities only. Once an account is claimed
        // (email / password / OAuth) the localStorage recovery token must NOT
        // re-authenticate it — it is a passwordless bearer credential that
        // survives the claim and is XSS-exfiltratable. Fold the claim check
        // INTO the CAS predicate so the refusal is ATOMIC with nonce
        // consumption (no separate-SELECT TOCTOU): a claimed row matches 0 rows
        // here and is disambiguated below as `account_claimed`.
        isNull(users.email),
        isNull(users.passwordHash),
        isNull(users.claimedAt),
        or(
          isNull(users.lastRecoveryNonce),
          ne(users.lastRecoveryNonce, verified.nonce),
        ),
      ),
    )
    .returning({ id: users.id })

  if (updateResult.length === 0) {
    const existing = await db
      .select({
        lastRecoveryNonce: users.lastRecoveryNonce,
        email: users.email,
        passwordHash: users.passwordHash,
        claimedAt: users.claimedAt,
      })
      .from(users)
      .where(eq(users.id, verified.sub))
      .limit(1)
      .get()
    if (!existing) {
      // Account deleted (GC'd or /me/delete'd). DO NOT silently mint
      // a new user — that would let the recovery flow attach an
      // attacker's localStorage to a fresh anonymous identity. The
      // client should clear its backup and proceed as new anon.
      return errorResponse('chat_not_found', 410, 'Account no longer exists')
    }
    if (
      existing.claimedAt !== null ||
      existing.email !== null ||
      existing.passwordHash !== null
    ) {
      // The identity was upgraded to a real account. The anonymous recovery
      // path is closed for it (a leaked recovery token must not be a
      // passwordless login). Distinct code so the client prompts a sign-in
      // instead of silently clearing the backup and dropping to a new anon.
      return errorResponse(
        'account_claimed',
        409,
        'This browser has an account. Sign in to continue.',
      )
    }
    // Row exists, still anonymous, but the nonce was already consumed — replay.
    return errorResponse('invalid_request', 409, 'Recovery token already used')
  }

  // Mint a fresh session cookie + a NEW recovery token (rolling refresh).
  const { recoveryToken } = await reissueSessionForRecovery(verified.sub)

  return new NextResponse(null, {
    status: 204,
    headers: {
      [RECOVERY_HEADER]: recoveryToken,
    },
  })
}
