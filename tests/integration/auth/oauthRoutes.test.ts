// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'

type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (n: string) => map.get(n),
    set: (n: string, v: string, o?: unknown) => map.set(n, { name: n, value: v, options: o }),
    delete: (n: string) => map.delete(n),
    _reset: () => map.clear(),
  }
})()
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }))
// Stub the network layer so the callback never makes real provider calls.
vi.mock('@/lib/auth/oauth/oauthUser', () => ({ exchangeCodeForUser: vi.fn() }))

beforeEach(async () => {
  cookieJar._reset()
  vi.stubEnv('SESSION_SECRET', 'test-secret-please-do-not-use-in-production-32+bytes')
  vi.stubEnv('RECOVERY_SECRET', 'recovery-test-secret-distinct-from-session-32+bytes-x')
  vi.stubEnv('SL_ACCOUNTS_ENABLED', '1')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-secret')
  vi.resetModules()
  const { __resetForTesting } = await import('@/lib/auth/authRateLimit')
  __resetForTesting()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

function get(path: string, params: Record<string, string> = {}): Request {
  const url = new URL(`http://localhost:3000${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url, { method: 'GET', headers: { host: 'localhost:3000' } })
}
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) })

describe('GET /api/auth/oauth/[provider]/start', () => {
  it('redirects to the provider and sets the SameSite=Lax flow cookie', async () => {
    const { GET } = await import('@/app/api/auth/oauth/[provider]/start/route')
    const res = await GET(get('/api/auth/oauth/google/start', { returnTo: '/editor' }), ctx('google'))
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('accounts.google.com')
    expect(loc).toContain('state=')
    expect(loc).toContain('code_challenge=') // PKCE
    expect(cookieJar.get('sl_oauth_google')).toBeDefined()
  })

  it('404s when the provider is not configured', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '')
    const { GET } = await import('@/app/api/auth/oauth/[provider]/start/route')
    expect((await GET(get('/api/auth/oauth/google/start'), ctx('google'))).status).toBe(404)
  })

  it('404s for an unknown provider', async () => {
    const { GET } = await import('@/app/api/auth/oauth/[provider]/start/route')
    expect((await GET(get('/api/auth/oauth/twitter/start'), ctx('twitter'))).status).toBe(404)
  })
})

describe('GET /api/auth/oauth/[provider]/callback', () => {
  async function setFlow(state: string) {
    const { setOAuthFlow } = await import('@/lib/auth/oauth/oauthState')
    await setOAuthFlow('google', { state, codeVerifier: 'V', returnTo: '/editor' })
  }

  it('redirects with oauth_error=state on a state mismatch and consumes the flow cookie', async () => {
    await setFlow('GOOD')
    const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route')
    const res = await GET(get('/api/auth/oauth/google/callback', { code: 'c', state: 'BAD' }), ctx('google'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('oauth_error=state')
    expect(cookieJar.get('sl_oauth_google')).toBeUndefined() // single-use
  })

  it('redirects with oauth_error=denied when the provider returns an error', async () => {
    await setFlow('GOOD')
    const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route')
    const res = await GET(get('/api/auth/oauth/google/callback', { error: 'access_denied' }), ctx('google'))
    expect(res.headers.get('location')).toContain('oauth_error=denied')
  })

  it('redirects to APP_BASE_URL origin, never the internal request host (no 0.0.0.0:3000)', async () => {
    // Regression: behind the proxy request.url host is the internal bind, so the
    // post-login redirect must come from APP_BASE_URL, not new URL(request.url).
    vi.stubEnv('APP_BASE_URL', 'https://sheetllm.com')
    await setFlow('GOOD')
    const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route')
    const res = await GET(get('/api/auth/oauth/google/callback', { error: 'access_denied' }), ctx('google'))
    const loc = res.headers.get('location') ?? ''
    expect(loc.startsWith('https://sheetllm.com/')).toBe(true)
    expect(loc).not.toContain('localhost')
    expect(loc).not.toContain('0.0.0.0')
  })

  it('claims the anon identity on a valid new-user callback → session + oauth=created', async () => {
    await setFlow('GOOD')
    const { exchangeCodeForUser } = await import('@/lib/auth/oauth/oauthUser')
    ;(exchangeCodeForUser as unknown as Mock).mockResolvedValue({
      provider: 'google',
      providerAccountId: 'g-1',
      email: 'new@example.com',
      emailVerified: true,
    })
    const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route')
    const res = await GET(get('/api/auth/oauth/google/callback', { code: 'c', state: 'GOOD' }), ctx('google'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('oauth=created')
    expect(cookieJar.get('sl_sess')).toBeDefined()
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const row = getDb().select().from(users).where(eq(users.email, 'new@example.com')).get()
    expect(row?.claimedAt).toBeTruthy() // claimed via OAuth → restore would refuse it
    expect(row?.emailVerified).toBe(1)
  })

  it('refuses an unverified provider email → oauth_error=email_unverified, no session', async () => {
    await setFlow('GOOD')
    const { exchangeCodeForUser } = await import('@/lib/auth/oauth/oauthUser')
    ;(exchangeCodeForUser as unknown as Mock).mockResolvedValue({
      provider: 'google',
      providerAccountId: 'g-2',
      email: 'x@example.com',
      emailVerified: false,
    })
    const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route')
    const res = await GET(get('/api/auth/oauth/google/callback', { code: 'c', state: 'GOOD' }), ctx('google'))
    expect(res.headers.get('location')).toContain('oauth_error=email_unverified')
    expect(cookieJar.get('sl_sess')).toBeUndefined()
  })
})
