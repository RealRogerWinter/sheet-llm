import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { getAccountById } from '@/lib/auth/account'
import { createAuthToken, invalidateUserTokens } from '@/lib/auth/authTokens'
import { checkEmailSend } from '@/lib/auth/emailRateLimit'
import { resolveAppBaseUrl, sendVerificationEmail } from '@/lib/auth/email'
import { authError, guardAuthMutation, rateLimited } from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/verify-email/send — (re)send the verification email to the
 * CURRENTLY AUTHENTICATED account. No body required. Bounded by the email send
 * budget; no-ops with 200 when already verified or the account has no email.
 */
export async function POST(request: Request) {
  const blocked = await guardAuthMutation(request)
  if (blocked) return blocked

  const ip = extractClientIp(request)
  const ipCheck = checkAuthIp(ip)
  if (!ipCheck.ok) return rateLimited(ipCheck.retryAfterSec)

  const session = await getExistingRequestUser()
  if (!session || !session.authenticated) {
    return authError('unauthenticated', 401, 'Sign in first.')
  }
  const account = await getAccountById(session.userId)
  if (!account?.email) {
    return authError('no_email', 400, 'This account has no email to verify.')
  }
  if (account.emailVerified === 1) {
    return NextResponse.json(
      { ok: true, alreadyVerified: true },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )
  }
  if (!checkEmailSend({ email: account.email, ip }).ok) {
    return rateLimited(60 * 60)
  }
  await invalidateUserTokens(account.id, 'email_verify')
  const token = await createAuthToken(account.id, 'email_verify')
  const link = `${resolveAppBaseUrl(request)}/verify-email?token=${token}`
  try {
    await sendVerificationEmail(account.email, link)
  } catch (e) {
    console.error('[auth] verification email send failed:', (e as Error).message)
    return authError('email_failed', 502, 'Could not send the email. Try again shortly.')
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
