import { cookies } from 'next/headers'
import type { OAuthProviderName } from './config'

/**
 * Per-flow OAuth cookie holding the CSRF `state`, the PKCE `codeVerifier`, and
 * the post-login `returnTo`. One httpOnly cookie per provider, **SameSite=Lax**
 * (Strict would be dropped on the provider→callback top-level redirect),
 * short-lived, single-use (the callback clears it before doing any work).
 */
const FLOW_TTL_S = 10 * 60 // 10 minutes

interface OAuthFlow {
  state: string
  codeVerifier: string
  returnTo: string
}

function cookieName(provider: OAuthProviderName): string {
  return `sl_oauth_${provider}`
}

function cookieSecure(): boolean {
  return process.env.SL_INSECURE_COOKIE_OK !== '1'
}

export async function setOAuthFlow(
  provider: OAuthProviderName,
  flow: OAuthFlow,
): Promise<void> {
  const store = await cookies()
  store.set(cookieName(provider), JSON.stringify({ s: flow.state, v: flow.codeVerifier, r: flow.returnTo }), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: FLOW_TTL_S,
  })
}

export async function readOAuthFlow(provider: OAuthProviderName): Promise<OAuthFlow | null> {
  const store = await cookies()
  const raw = store.get(cookieName(provider))?.value
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.s !== 'string' || typeof parsed?.v !== 'string') return null
    return {
      state: parsed.s,
      codeVerifier: parsed.v,
      returnTo: typeof parsed.r === 'string' ? parsed.r : '/',
    }
  } catch {
    return null
  }
}

export async function clearOAuthFlow(provider: OAuthProviderName): Promise<void> {
  const store = await cookies()
  store.delete(cookieName(provider))
}

/**
 * Allowlist `returnTo` to INTERNAL paths only — must start with a single '/'
 * (not '//' or a scheme), so OAuth can't be turned into an open redirect to an
 * attacker site. Anything else collapses to '/'.
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/'
  }
  return raw
}
