import { exchangeCodeForAccessToken, type OAuthProviderName } from './config'

/**
 * The normalized identity we extract from a provider after the token exchange.
 * `email`/`emailVerified` are used ONLY by oauthLink.ts to decide linking; an
 * unverified or absent email can never silently link to a local account.
 */
export interface OAuthUser {
  provider: OAuthProviderName
  /** Stable provider user id (Google `sub`, GitHub numeric `id`). */
  providerAccountId: string
  email: string | null
  emailVerified: boolean
}

const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'
const GITHUB_USER = 'https://api.github.com/user'
const GITHUB_EMAILS = 'https://api.github.com/user/emails'

async function fetchGoogleUser(accessToken: string): Promise<OAuthUser> {
  const res = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`google userinfo ${res.status}`)
  const d = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean | string }
  if (!d.sub) throw new Error('google userinfo missing sub')
  return {
    provider: 'google',
    providerAccountId: String(d.sub),
    email: typeof d.email === 'string' ? d.email : null,
    // Google returns a boolean; tolerate the legacy string form too.
    emailVerified: d.email_verified === true || d.email_verified === 'true',
  }
}

async function fetchGithubUser(accessToken: string): Promise<OAuthUser> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'sheet-llm',
  }
  const userRes = await fetch(GITHUB_USER, { headers })
  if (!userRes.ok) throw new Error(`github user ${userRes.status}`)
  const user = (await userRes.json()) as { id?: number | string }
  if (user.id === undefined || user.id === null) throw new Error('github user missing id')

  const emailsRes = await fetch(GITHUB_EMAILS, { headers })
  if (!emailsRes.ok) throw new Error(`github emails ${emailsRes.status}`)
  const emails = (await emailsRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
  // ONLY the primary VERIFIED address. We never trust the top-level `user.email`
  // and never accept an unverified email (GitHub lets users add unverified ones).
  const primary = Array.isArray(emails)
    ? emails.find((e) => e.primary === true && e.verified === true && typeof e.email === 'string')
    : undefined
  return {
    provider: 'github',
    providerAccountId: String(user.id),
    email: primary?.email ?? null,
    emailVerified: Boolean(primary),
  }
}

export async function fetchOAuthUser(
  provider: OAuthProviderName,
  accessToken: string,
): Promise<OAuthUser> {
  return provider === 'google' ? fetchGoogleUser(accessToken) : fetchGithubUser(accessToken)
}

/** Exchange the authorization code for tokens, then fetch the provider profile. */
export async function exchangeCodeForUser(
  provider: OAuthProviderName,
  request: Request,
  code: string,
  codeVerifier: string,
): Promise<OAuthUser> {
  const accessToken = await exchangeCodeForAccessToken(provider, request, code, codeVerifier)
  return fetchOAuthUser(provider, accessToken)
}
