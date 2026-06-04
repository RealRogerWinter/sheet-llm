import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestUser } from '@/lib/auth/session'
import { createAuthSession } from '@/lib/auth/sessionStore'
import { hashPassword } from '@/lib/auth/password'
import { claimAccountWithPassword, normalizeEmail } from '@/lib/auth/account'
import {
  authError,
  clientUserAgent,
  guardAuthMutation,
  rateLimited,
  readJsonBody,
} from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'
import { checkEmailSend } from '@/lib/auth/emailRateLimit'
import { isDisposableEmail } from '@/lib/auth/disposableDomains'
import { createAuthToken } from '@/lib/auth/authTokens'
import { resolveAppBaseUrl, sendVerificationEmail } from '@/lib/auth/email'
import { issueCsrfToken } from '@/lib/auth/httpGuards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
})

/**
 * POST /api/auth/signup — claim the current anonymous identity as an
 * email+password account (in place; sessions/scores carry over), set
 * `claimed_at` (closing the anonymous recovery path), and mint a DB-backed login
 * session. Email verification is sent in PR-5; the account starts unverified.
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
  if (!result.success) {
    return authError(
      'invalid_request',
      400,
      'Enter a valid email and a password of at least 10 characters.',
    )
  }
  const { email, password } = result.data
  const norm = normalizeEmail(email)
  if (isDisposableEmail(norm)) {
    return authError(
      'disposable_email',
      400,
      'Please sign up with a non-disposable email address.',
    )
  }

  // A logged-in user must not "sign up" onto their own session.
  const session = await getRequestUser()
  if (session.authenticated) {
    return authError('already_authenticated', 409, 'You are already signed in.')
  }

  const passwordHash = await hashPassword(password)
  const claim = await claimAccountWithPassword(
    session.userId,
    email,
    passwordHash,
    Math.floor(Date.now() / 1000),
  )
  if (claim === 'email_taken') {
    return authError(
      'email_taken',
      409,
      'An account with that email already exists. Try signing in.',
    )
  }
  if (claim === 'gone') {
    return authError('invalid_request', 401, 'Your session expired. Reload and try again.')
  }

  await createAuthSession(session.userId, { userAgent: clientUserAgent(request), ip })
  await issueCsrfToken()

  // Fire-and-forget verification email (within the send budget). Signup succeeds
  // regardless — a send failure just means the user resends it from settings.
  if (checkEmailSend({ email: norm, ip }).ok) {
    const token = await createAuthToken(session.userId, 'email_verify')
    const link = `${resolveAppBaseUrl(request)}/verify-email?token=${token}`
    void sendVerificationEmail(norm, link).catch((e) =>
      console.error('[auth] verification email send failed:', (e as Error).message),
    )
  }
  return NextResponse.json(
    { ok: true, emailVerified: false, clearLocalStorage: ['sheet-llm:recovery'] },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}
