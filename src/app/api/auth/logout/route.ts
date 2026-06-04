import { NextResponse } from 'next/server'
import { revokeCurrentAuthSession } from '@/lib/auth/sessionStore'
import { clearSessionCookie } from '@/lib/auth/session'
import { guardAuthMutation } from '@/lib/auth/routeGuard'
import { issueCsrfToken } from '@/lib/auth/httpGuards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/logout — revoke the current DB session and clear sl_sess +
 * sl_auth AND the anonymous sl_uid, so the browser becomes a CLEAN visitor (a
 * fresh anon is lazily minted on the next write). Drops the recovery backup.
 */
export async function POST(request: Request) {
  const blocked = await guardAuthMutation(request)
  if (blocked) return blocked

  await revokeCurrentAuthSession()
  await clearSessionCookie()
  await issueCsrfToken()
  return NextResponse.json(
    { ok: true, clearLocalStorage: ['sheet-llm:recovery'] },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}
