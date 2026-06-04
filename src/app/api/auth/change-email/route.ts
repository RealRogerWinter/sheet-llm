import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getExistingRequestUser } from '@/lib/auth/session'
import { getAccountById, isUniqueViolation, normalizeEmail } from '@/lib/auth/account'
import { verifyPassword } from '@/lib/auth/password'
import { isDisposableEmail } from '@/lib/auth/disposableDomains'
import { createAuthToken, invalidateUserTokens } from '@/lib/auth/authTokens'
import { checkEmailSend } from '@/lib/auth/emailRateLimit'
import { resolveAppBaseUrl, sendVerificationEmail } from '@/lib/auth/email'
import { authError, guardAuthMutation, rateLimited, readJsonBody } from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  newEmail: z.string().email().max(254),
  currentPassword: z.string().min(1).max(200),
})

/**
 * POST /api/auth/change-email — authenticated. Verify the current password (so a
 * hijacked session can't silently move the address), set the new normalized
 * email, mark it UNVERIFIED, and send a verification link to the new address.
 * The session is untouched.
 */
export async function POST(request: Request) {
  const blocked = await guardAuthMutation(request)
  if (blocked) return blocked
  const ip = extractClientIp(request)
  if (!checkAuthIp(ip).ok) return rateLimited()

  const session = await getExistingRequestUser()
  if (!session || !session.authenticated) {
    return authError('unauthenticated', 401, 'Sign in first.')
  }
  const parsed = await readJsonBody(request)
  if (!parsed.ok) return parsed.res
  const result = BodySchema.safeParse(parsed.body)
  if (!result.success) {
    return authError('invalid_request', 400, 'Enter a valid email and your current password.')
  }
  const norm = normalizeEmail(result.data.newEmail)
  if (isDisposableEmail(norm)) {
    return authError('disposable_email', 400, 'Please use a non-disposable email address.')
  }

  const account = await getAccountById(session.userId)
  if (!account?.passwordHash) {
    return authError('no_password', 400, 'Set a password before changing your email.')
  }
  if (!(await verifyPassword(account.passwordHash, result.data.currentPassword))) {
    return authError('invalid_credentials', 401, 'Your current password is incorrect.')
  }

  try {
    await getDb()
      .update(users)
      .set({ email: norm, emailVerified: 0 })
      .where(eq(users.id, session.userId))
  } catch (e) {
    if (isUniqueViolation(e)) {
      return authError('email_taken', 409, 'An account with that email already exists.')
    }
    throw e
  }

  if (checkEmailSend({ email: norm, ip }).ok) {
    await invalidateUserTokens(session.userId, 'email_verify')
    const token = await createAuthToken(session.userId, 'email_verify')
    const link = `${resolveAppBaseUrl(request)}/verify-email?token=${token}`
    void sendVerificationEmail(norm, link).catch((e) =>
      console.error('[auth] verification email send failed:', (e as Error).message),
    )
  }
  return NextResponse.json(
    { ok: true, email: norm, emailVerified: false },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}
