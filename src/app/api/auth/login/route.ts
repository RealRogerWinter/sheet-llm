import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAuthSession } from '@/lib/auth/sessionStore'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { findUserByEmail, normalizeEmail } from '@/lib/auth/account'
import {
  authError,
  clientUserAgent,
  guardAuthMutation,
  rateLimited,
  readJsonBody,
} from '@/lib/auth/routeGuard'
import {
  checkAuthIp,
  checkEmailThrottle,
  extractClientIp,
  recordEmailFailure,
} from '@/lib/auth/authRateLimit'
import { issueCsrfToken } from '@/lib/auth/httpGuards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  rememberMe: z.boolean().optional(),
})

// Lazily-computed REAL argon2id hash for the unknown-email path, so a missing
// account takes the same time as a wrong password (no timing/enumeration oracle).
let dummyHash: string | null = null
async function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = await hashPassword('timing-equalization-dummy-password')
  return dummyHash
}

/**
 * POST /api/auth/login — verify email+password and mint a fresh DB-backed
 * session. Enumeration-resistant: always runs a real argon2 verify (against a
 * dummy hash on a miss) and returns an identical 401 for unknown-email vs
 * wrong-password. Per-IP + per-email failed-login throttling.
 */
export async function POST(request: Request) {
  const blocked = await guardAuthMutation(request)
  if (blocked) return blocked

  const ip = extractClientIp(request)
  const ipCheck = checkAuthIp(ip)
  if (!ipCheck.ok) return rateLimited(ipCheck.retryAfterSec)

  const parsed = await readJsonBody(request)
  if (!parsed.ok) return parsed.res
  const result = BodySchema.safeParse(parsed.body)
  if (!result.success) return authError('invalid_request', 400, 'Enter your email and password.')
  const { email, password, rememberMe } = result.data
  const norm = normalizeEmail(email)

  const account = await findUserByEmail(norm)
  // ALWAYS run a real argon2 verify (against a dummy hash on a miss) so an
  // unknown email and a wrong password are time- and response-indistinguishable.
  const ok = await verifyPassword(account?.passwordHash ?? (await getDummyHash()), password)
  if (account && account.passwordHash && ok) {
    // SUCCESS — reached BEFORE any per-email throttle, so the throttle can NEVER
    // lock out the legitimate owner (only failed attempts are gated below). A
    // fresh session rotates away any stale state.
    await createAuthSession(account.id, {
      rememberMe,
      userAgent: clientUserAgent(request),
      ip,
    })
    await issueCsrfToken()
    return NextResponse.json(
      {
        ok: true,
        email: account.email,
        emailVerified: account.emailVerified === 1,
        tier: account.tier,
        clearLocalStorage: ['sheet-llm:recovery'],
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )
  }
  // FAILURE only: brake further FAILED attempts for this email (a
  // credential-stuffing speed-bump) — this gates the failure response, never a
  // correct login, so a clean-IP owner with the right password is never blocked.
  const throttle = checkEmailThrottle(norm)
  recordEmailFailure(norm)
  if (!throttle.ok) return rateLimited(throttle.retryAfterSec)
  return authError('invalid_credentials', 401, 'Email or password is incorrect.')
}
