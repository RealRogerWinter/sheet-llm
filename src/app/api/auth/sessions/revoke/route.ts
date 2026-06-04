import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getExistingRequestUser } from '@/lib/auth/session'
import { revokeAuthSessionById } from '@/lib/auth/sessionStore'
import { authError, guardAuthMutation, rateLimited, readJsonBody } from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({ id: z.string().min(1).max(100) })

/**
 * POST /api/auth/sessions/revoke — authenticated. Revoke ONE of the user's OWN
 * sessions by id ("sign out this device" from the list). Only revokes a row that
 * belongs to the caller; revoking the current session simply logs this device
 * out. `revoked` is false if the id wasn't a live session of theirs.
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
  if (!result.success) return authError('invalid_request', 400, 'Missing session id.')

  const revoked = await revokeAuthSessionById(session.userId, result.data.id)
  return NextResponse.json({ ok: true, revoked }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
