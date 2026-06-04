import { NextResponse } from 'next/server'
import { generateState, generateCodeVerifier } from 'arctic'
import { isAccountsEnabled } from '@/lib/auth/account'
import {
  buildAuthorizationURL,
  isOAuthConfigured,
  isOAuthProviderName,
} from '@/lib/auth/oauth/config'
import { sanitizeReturnTo, setOAuthFlow } from '@/lib/auth/oauth/oauthState'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/oauth/[provider]/start — begin an OAuth login. Mints a CSRF
 * `state` + PKCE `codeVerifier`, stashes them (+ a sanitized `returnTo`) in a
 * short-lived SameSite=Lax cookie, and redirects to the provider. GET (a
 * top-level navigation), so it is not CSRF-gated — the actual account change at
 * the callback is bound to this state.
 */
export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  if (!isAccountsEnabled()) return new NextResponse('Not found', { status: 404 })
  const { provider } = await ctx.params
  if (!isOAuthProviderName(provider) || !isOAuthConfigured(provider)) {
    return new NextResponse('OAuth provider unavailable', { status: 404 })
  }
  const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get('returnTo'))
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const authUrl = buildAuthorizationURL(provider, request, state, codeVerifier)
  await setOAuthFlow(provider, { state, codeVerifier, returnTo })
  return NextResponse.redirect(authUrl, { status: 302 })
}
