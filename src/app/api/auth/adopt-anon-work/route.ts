import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { adoptAnonWorkInto } from '@/lib/auth/adoptAnonWork'
import { verifyAuthSession } from '@/lib/auth/sessionStore'
import { authError, guardAuthMutation } from '@/lib/auth/routeGuard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/adopt-anon-work — migrate the sessions/scores created under the
 * browser's pre-login ANONYMOUS identity onto the now-authenticated account. This
 * is what makes the post-login "Keep my work" choice actually keep the work:
 * `/api/auth/login` mints a fresh `sl_sess` for the existing account but never
 * touches the anonymous `sl_uid` (a different userId), so without this the anon
 * scores stay stranded under the old id and never appear in the account's
 * sidebar. (Signup doesn't need this — `claimAccountWithPassword` claims the anon
 * identity IN PLACE, keeping the same userId.)
 *
 * SECURITY: the anon userId is read SERVER-SIDE from the verified `sl_uid` cookie
 * (`readAnonCookieIdentity`), NEVER from client input, so a caller can't migrate
 * an arbitrary user's sessions (no IDOR). The migration TARGET is strictly the
 * `sl_sess`-authenticated user. Only an UNCLAIMED anon identity distinct from the
 * account is adopted, and ONLY the `sessions` table moves — IP/credit/quota
 * records stay keyed to their original owner. After a successful adoption the
 * `sl_uid` is cleared so the absorbed identity can't be re-adopted. Guarded like
 * every auth mutation (accounts-enabled + strict same-origin + JSON + CSRF).
 */
export async function POST(request: Request) {
  const blocked = await guardAuthMutation(request)
  if (blocked) return blocked

  const db = getDb()
  const authed = await verifyAuthSession(db)
  if (!authed) {
    return authError('unauthorized', 401, 'You must be signed in to keep your previous work.')
  }

  const migrated = await adoptAnonWorkInto(authed.userId)
  return NextResponse.json(
    { ok: true, migrated },
    { headers: { 'cache-control': 'no-store' } },
  )
}
