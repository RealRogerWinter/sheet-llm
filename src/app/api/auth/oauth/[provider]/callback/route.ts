import { NextResponse } from 'next/server'
import { isAccountsEnabled } from '@/lib/auth/account'
import { isOAuthConfigured, isOAuthProviderName } from '@/lib/auth/oauth/config'
import { clearOAuthFlow, readOAuthFlow, sanitizeReturnTo } from '@/lib/auth/oauth/oauthState'
import { exchangeCodeForUser } from '@/lib/auth/oauth/oauthUser'
import { resolveOAuthLogin } from '@/lib/auth/oauth/oauthLink'
import { getRequestUser } from '@/lib/auth/session'
import { createAuthSession } from '@/lib/auth/sessionStore'
import { clientUserAgent } from '@/lib/auth/routeGuard'
import { checkAuthIp, extractClientIp } from '@/lib/auth/authRateLimit'
import { issueCsrfToken } from '@/lib/auth/httpGuards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The PUBLIC base origin to redirect users to. Behind the reverse proxy,
// `request.url`'s host is the app's internal bind (e.g. http://0.0.0.0:3000) —
// redirecting there sends the user to a dead localhost URL after login. Prefer
// APP_BASE_URL, then OAUTH_REDIRECT_BASE_URL, then the request origin (dev).
function appBaseOrigin(request: Request): string {
  const configured = process.env.APP_BASE_URL || process.env.OAUTH_REDIRECT_BASE_URL
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      /* malformed env → fall through to the request origin */
    }
  }
  return new URL(request.url).origin
}

function appRedirect(request: Request, returnTo: string, params: Record<string, string>): NextResponse {
  const url = new URL(sanitizeReturnTo(returnTo), appBaseOrigin(request))
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url, { status: 302 })
}

/**
 * GET /api/auth/oauth/[provider]/callback — the provider redirect target.
 * Exempt from the same-origin gate (it is a top-level redirect FROM the
 * provider); CSRF is enforced by the single-use `state` cookie instead. On
 * success mints a fresh login session and redirects to `returnTo`; on any
 * failure redirects with `?oauth_error=<code>` for the client to surface.
 */
export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  if (!isAccountsEnabled()) return new NextResponse('Not found', { status: 404 })
  const { provider } = await ctx.params
  if (!isOAuthProviderName(provider) || !isOAuthConfigured(provider)) {
    return new NextResponse('OAuth provider unavailable', { status: 404 })
  }

  const url = new URL(request.url)
  const flow = await readOAuthFlow(provider)
  await clearOAuthFlow(provider) // single-use: consume the flow cookie no matter the result
  const returnTo = flow?.returnTo ?? '/'

  if (url.searchParams.get('error')) {
    // The user denied consent (or the provider errored).
    return appRedirect(request, returnTo, { oauth_error: 'denied' })
  }
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  // Hard-fail on a missing/mismatched state — the OAuth CSRF defense.
  if (!code || !stateParam || !flow || flow.state !== stateParam) {
    return appRedirect(request, returnTo, { oauth_error: 'state' })
  }

  // A valid state cookie is required to reach here, but still bound how often one
  // client can drive the (provider-hitting) token exchange.
  const ip = extractClientIp(request)
  if (!checkAuthIp(ip).ok) {
    return appRedirect(request, returnTo, { oauth_error: 'rate_limited' })
  }

  let oauthUser
  try {
    oauthUser = await exchangeCodeForUser(provider, request, code, flow.codeVerifier)
  } catch (e) {
    console.error('[oauth] code exchange failed:', (e as Error).message)
    return appRedirect(request, returnTo, { oauth_error: 'exchange' })
  }

  const current = await getRequestUser()
  const outcome = await resolveOAuthLogin(oauthUser, {
    userId: current.userId,
    authenticated: current.authenticated,
  })
  if (!outcome.ok) {
    return appRedirect(request, returnTo, { oauth_error: outcome.error })
  }
  await createAuthSession(outcome.userId, {
    userAgent: clientUserAgent(request),
    ip,
  })
  await issueCsrfToken()
  return appRedirect(request, returnTo, { oauth: outcome.kind })
}
