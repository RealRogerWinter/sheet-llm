import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { consumeAuthToken } from '@/lib/auth/authTokens'
import {
  authError,
  guardAuthMutation,
  rateLimited,
  readJsonBody,
} from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({ token: z.string().min(20).max(512) })

/**
 * POST /api/auth/verify-email — confirm an email address from the verification
 * link. POST-only ON PURPOSE: the email link points at a PAGE that posts on
 * landing, so inbox scanners / link-prefetchers that only issue GETs can't
 * silently consume the single-use token.
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
    return authError('invalid_token', 400, 'This verification link is invalid.')
  }
  const consumed = await consumeAuthToken(result.data.token, 'email_verify')
  if (!consumed) {
    return authError('invalid_token', 400, 'This verification link is invalid or has expired.')
  }
  await getDb().update(users).set({ emailVerified: 1 }).where(eq(users.id, consumed.userId))
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
