import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { getAccountById, isAccountsEnabled } from '@/lib/auth/account'
import { isOAuthConfigured } from '@/lib/auth/oauth/config'
import { issueCsrfToken } from '@/lib/auth/httpGuards'
import { maybeReapAuth } from '@/lib/db/maybeReap'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function noStore(body: unknown): NextResponse {
  return NextResponse.json(body, { status: 200, headers: { 'cache-control': 'no-store' } })
}

/** Which OAuth providers have credentials configured (so the UI shows buttons). */
function configuredOAuthProviders(): string[] {
  return (['google', 'github'] as const).filter((p) => isOAuthConfigured(p))
}

/**
 * GET /api/auth/session — the client's source of truth for auth state (nav,
 * pro-gating). ALWAYS read fresh from the DB (never a client copy). Also issues
 * /refreshes a double-submit CSRF token on every call, so the client holds a
 * valid token before any auth POST.
 */
export async function GET() {
  const csrfToken = await issueCsrfToken()
  if (!isAccountsEnabled()) {
    return noStore({ enabled: false, authenticated: false, csrfToken })
  }
  maybeReapAuth() // opportunistic, throttled GC of dead auth tokens/sessions
  const oauthProviders = configuredOAuthProviders()
  const session = await getExistingRequestUser()
  if (!session || !session.authenticated) {
    return noStore({ enabled: true, authenticated: false, csrfToken, oauthProviders })
  }
  const account = await getAccountById(session.userId)
  return noStore({
    enabled: true,
    authenticated: true,
    email: account?.email ?? null,
    emailVerified: account?.emailVerified === 1,
    tier: account?.tier ?? 'free',
    csrfToken,
    oauthProviders,
  })
}
