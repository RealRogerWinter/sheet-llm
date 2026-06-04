import { NextResponse } from 'next/server'
import { revokeAllAuthSessions } from '@/lib/auth/sessionStore'
import { clearSessionCookie, getExistingRequestUser } from '@/lib/auth/session'
import { authError, guardAuthMutation } from '@/lib/auth/routeGuard'
import { issueCsrfToken } from '@/lib/auth/httpGuards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/logout-all — "log out everywhere": revoke EVERY live DB session
 * for the account (including this one), then clear cookies. Used from account
 * settings and after a password reset.
 */
export async function POST(request: Request) {
  const blocked = await guardAuthMutation(request)
  if (blocked) return blocked

  const session = await getExistingRequestUser()
  if (!session || !session.authenticated) {
    return authError('not_authenticated', 401, 'Not signed in.')
  }
  const revoked = await revokeAllAuthSessions(session.userId)
  await clearSessionCookie()
  await issueCsrfToken()
  return NextResponse.json(
    { ok: true, revoked, clearLocalStorage: ['sheet-llm:recovery'] },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}
