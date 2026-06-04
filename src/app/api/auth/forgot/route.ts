import { NextResponse } from 'next/server'
import { z } from 'zod'
import { findUserByEmail, normalizeEmail } from '@/lib/auth/account'
import {
  guardAuthMutation,
  rateLimited,
  readJsonBody,
} from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'
import { checkEmailSend } from '@/lib/auth/emailRateLimit'
import { createAuthToken, invalidateUserTokens } from '@/lib/auth/authTokens'
import { resolveAppBaseUrl, sendPasswordResetEmail } from '@/lib/auth/email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({ email: z.string().email().max(254) })

/**
 * POST /api/auth/forgot — request a password-reset link. ALWAYS returns an
 * identical 200 (no account enumeration). Real work happens only for an existing
 * PASSWORD account within the send budget; the provider call is fire-and-forget
 * so response timing doesn't leak whether mail was actually sent. (A residual
 * ~1ms DB-write timing difference for existing accounts is accepted for v1.)
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
  if (result.success) {
    const norm = normalizeEmail(result.data.email)
    const account = await findUserByEmail(norm)
    // Only PASSWORD accounts can reset; OAuth-only (null hash) silently no-ops.
    if (account?.passwordHash && checkEmailSend({ email: norm, ip }).ok) {
      await invalidateUserTokens(account.id, 'password_reset')
      const token = await createAuthToken(account.id, 'password_reset')
      const link = `${resolveAppBaseUrl(request)}/reset?token=${token}`
      void sendPasswordResetEmail(norm, link).catch((e) =>
        console.error('[auth] reset email send failed:', (e as Error).message),
      )
    }
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
