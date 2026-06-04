// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

describe('fetchOAuthUser — google', () => {
  it('maps sub + email + email_verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sub: '123', email: 'a@x.com', email_verified: true })))
    const { fetchOAuthUser } = await import('@/lib/auth/oauth/oauthUser')
    expect(await fetchOAuthUser('google', 'tok')).toEqual({
      provider: 'google',
      providerAccountId: '123',
      email: 'a@x.com',
      emailVerified: true,
    })
  })

  it('treats email_verified:false as unverified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sub: '123', email: 'a@x.com', email_verified: false })))
    const { fetchOAuthUser } = await import('@/lib/auth/oauth/oauthUser')
    expect((await fetchOAuthUser('google', 'tok')).emailVerified).toBe(false)
  })

  it('throws on a non-2xx userinfo response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const { fetchOAuthUser } = await import('@/lib/auth/oauth/oauthUser')
    await expect(fetchOAuthUser('google', 'tok')).rejects.toThrow(/401/)
  })
})

describe('fetchOAuthUser — github', () => {
  it('picks the PRIMARY VERIFIED email and the numeric id (ignores secondary/unverified)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/user')) return jsonResponse({ id: 42, login: 'octocat' })
        if (String(url).endsWith('/user/emails')) {
          return jsonResponse([
            { email: 'secondary@x.com', primary: false, verified: true },
            { email: 'primary@x.com', primary: true, verified: true },
            { email: 'noisy@x.com', primary: false, verified: false },
          ])
        }
        throw new Error(`unexpected url ${url}`)
      }),
    )
    const { fetchOAuthUser } = await import('@/lib/auth/oauth/oauthUser')
    expect(await fetchOAuthUser('github', 'tok')).toEqual({
      provider: 'github',
      providerAccountId: '42',
      email: 'primary@x.com',
      emailVerified: true,
    })
  })

  it('returns unverified (email null) when no primary VERIFIED email exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/user')) return jsonResponse({ id: 7 })
        return jsonResponse([{ email: 'p@x.com', primary: true, verified: false }])
      }),
    )
    const { fetchOAuthUser } = await import('@/lib/auth/oauth/oauthUser')
    const u = await fetchOAuthUser('github', 'tok')
    expect(u.email).toBeNull()
    expect(u.emailVerified).toBe(false)
    expect(u.providerAccountId).toBe('7')
  })
})
