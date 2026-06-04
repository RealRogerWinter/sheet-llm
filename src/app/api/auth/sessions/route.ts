import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { isAccountsEnabled } from '@/lib/auth/account'
import { listAuthSessions } from '@/lib/auth/sessionStore'
import { authError } from '@/lib/auth/routeGuard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/sessions — the authenticated user's LIVE login sessions for the
 * account-settings "active sessions" list, with the current one flagged. Tokens
 * are never exposed. Read-only (no CSRF gate needed).
 */
export async function GET() {
  if (!isAccountsEnabled()) return authError('not_found', 404, 'Not found')
  const session = await getExistingRequestUser()
  if (!session || !session.authenticated) {
    return authError('unauthenticated', 401, 'Sign in first.')
  }
  const sessions = await listAuthSessions(session.userId)
  return NextResponse.json({ sessions }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
