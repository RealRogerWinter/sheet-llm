import { Google, GitHub } from 'arctic'

/**
 * OAuth provider configuration. Google + GitHub via `arctic` (it owns the
 * protocol mechanics: authorization-URL building, PKCE for Google, and the
 * token exchange). Everything security-relevant about LINKING accounts lives in
 * oauthLink.ts; this module is just config + URL building.
 *
 * A provider is "configured" only when its client id AND secret are set, so the
 * Sign-in buttons can be hidden / the routes 404 when an operator hasn't set
 * credentials. Redirect URI = OAUTH_REDIRECT_BASE_URL (set in prod, behind a
 * proxy) or the request origin (single-domain dev/v1).
 */
export type OAuthProviderName = 'google' | 'github'

const PROVIDER_NAMES: readonly OAuthProviderName[] = ['google', 'github']

export function isOAuthProviderName(s: string): s is OAuthProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(s)
}

function credentials(provider: OAuthProviderName): { id?: string; secret?: string } {
  return provider === 'google'
    ? { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET }
    : { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET }
}

/** True only when BOTH the client id and secret are configured for `provider`. */
export function isOAuthConfigured(provider: OAuthProviderName): boolean {
  const { id, secret } = credentials(provider)
  return Boolean(id && secret)
}

export function oauthScopes(provider: OAuthProviderName): string[] {
  // Google: OIDC email + profile. GitHub: read:user + user:email (the latter is
  // REQUIRED to read /user/emails and find the primary VERIFIED address).
  return provider === 'google'
    ? ['openid', 'email', 'profile']
    : ['read:user', 'user:email']
}

function redirectBase(request: Request): string {
  const configured = process.env.OAUTH_REDIRECT_BASE_URL
  if (configured) return configured.replace(/\/+$/, '')
  return new URL(request.url).origin
}

export function oauthRedirectUri(provider: OAuthProviderName, request: Request): string {
  return `${redirectBase(request)}/api/auth/oauth/${provider}/callback`
}

function client(provider: OAuthProviderName, request: Request): Google | GitHub {
  const { id, secret } = credentials(provider)
  const redirectUri = oauthRedirectUri(provider, request)
  // Caller guarantees isOAuthConfigured(); assert for the type narrowing.
  return provider === 'google'
    ? new Google(id as string, secret as string, redirectUri)
    : new GitHub(id as string, secret as string, redirectUri)
}

/** Build the provider authorization URL (Google needs the PKCE verifier). */
export function buildAuthorizationURL(
  provider: OAuthProviderName,
  request: Request,
  state: string,
  codeVerifier: string,
): URL {
  const c = client(provider, request)
  return c instanceof Google
    ? c.createAuthorizationURL(state, codeVerifier, oauthScopes(provider))
    : c.createAuthorizationURL(state, oauthScopes(provider))
}

/** Exchange the authorization `code` for tokens and return the access token. */
export async function exchangeCodeForAccessToken(
  provider: OAuthProviderName,
  request: Request,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const c = client(provider, request)
  const tokens =
    c instanceof Google
      ? await c.validateAuthorizationCode(code, codeVerifier)
      : await c.validateAuthorizationCode(code)
  return tokens.accessToken()
}
