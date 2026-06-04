import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getExistingRequestUser } from '@/lib/auth/session'
import { getAccountById } from '@/lib/auth/account'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { createAuthSession, revokeAllAuthSessions } from '@/lib/auth/sessionStore'
import { sendPasswordChangedEmail } from '@/lib/auth/email'
import {
  authError,
  clientUserAgent,
  guardAuthMutation,
  rateLimited,
  readJsonBody,
} from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'
import { issueCsrfToken } from '@/lib/auth/httpGuards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
})

/**
 * POST /api/auth/change-password — authenticated. Verify the current password,
 * write the new hash, then REVOKE ALL sessions and mint a fresh one for THIS
 * device (rotation): a session stolen on another device is killed, while the
 * user stays logged in here. A confirmation email is sent.
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
    return authError(
      'invalid_request',
      400,
      'Enter your current password and a new password of at least 10 characters.',
    )
  }
  const { currentPassword, newPassword } = result.data

  const account = await getAccountById(session.userId)
  if (!account?.passwordHash) {
    return authError('no_password', 400, 'This account has no password. Use "Forgot password" to set one.')
  }
  if (!(await verifyPassword(account.passwordHash, currentPassword))) {
    return authError('invalid_credentials', 401, 'Your current password is incorrect.')
  }

  const newHash = await hashPassword(newPassword)
  await getDb().update(users).set({ passwordHash: newHash }).where(eq(users.id, session.userId))
  await revokeAllAuthSessions(session.userId)
  await createAuthSession(session.userId, { userAgent: clientUserAgent(request), ip })
  await issueCsrfToken()
  if (account.email) {
    void sendPasswordChangedEmail(account.email).catch((e) =>
      console.error('[auth] password-changed email failed:', (e as Error).message),
    )
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
