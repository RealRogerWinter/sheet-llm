import { NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { authSessions, users } from '@/lib/db/schema'
import { hashPassword } from '@/lib/auth/password'
import { getAccountById } from '@/lib/auth/account'
import { consumeAuthToken } from '@/lib/auth/authTokens'
import { sendPasswordChangedEmail } from '@/lib/auth/email'
import {
  authError,
  guardAuthMutation,
  rateLimited,
  readJsonBody,
} from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  token: z.string().min(20).max(512),
  password: z.string().min(10).max(200),
})

/**
 * POST /api/auth/reset — set a new password from a single-use reset token.
 * Atomically consumes the token, writes the new hash, marks the email verified
 * (the user just proved inbox control), and REVOKES ALL sessions (a reset is a
 * recovery action — force re-login everywhere, killing any attacker session).
 * Does NOT auto-login; the client sends the user to sign in.
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
    return authError('invalid_request', 400, 'Enter a new password of at least 10 characters.')
  }
  const { token, password } = result.data

  const consumed = await consumeAuthToken(token, 'password_reset')
  if (!consumed) {
    return authError(
      'invalid_token',
      400,
      'This reset link is invalid or has expired. Request a new one.',
    )
  }

  const passwordHash = await hashPassword(password)
  // Atomic: write the new password AND revoke EVERY session in one transaction,
  // so a crash can't leave the new password live while old (possibly attacker)
  // sessions survive. (better-sqlite3 transactions are synchronous.)
  const nowSec = Math.floor(Date.now() / 1000)
  getDb().transaction((tx) => {
    tx.update(users)
      .set({ passwordHash, emailVerified: 1 })
      .where(eq(users.id, consumed.userId))
      .run()
    tx.update(authSessions)
      .set({ revokedAt: nowSec })
      .where(and(eq(authSessions.userId, consumed.userId), isNull(authSessions.revokedAt)))
      .run()
  })

  const account = await getAccountById(consumed.userId)
  if (account?.email) {
    void sendPasswordChangedEmail(account.email).catch((e) =>
      console.error('[auth] password-changed email failed:', (e as Error).message),
    )
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
