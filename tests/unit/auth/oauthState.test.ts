// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

beforeEach(() => cookieJar._reset())

describe('sanitizeReturnTo', () => {
  it('allows internal paths, rejects external / protocol-relative / scheme', async () => {
    const { sanitizeReturnTo } = await import('@/lib/auth/oauth/oauthState')
    expect(sanitizeReturnTo('/editor')).toBe('/editor')
    expect(sanitizeReturnTo('/a?b=1#c')).toBe('/a?b=1#c')
    expect(sanitizeReturnTo('//evil.com')).toBe('/')
    expect(sanitizeReturnTo('https://evil.com')).toBe('/')
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/')
    expect(sanitizeReturnTo(null)).toBe('/')
    expect(sanitizeReturnTo('relative')).toBe('/')
  })
})

describe('oauth flow cookie', () => {
  it('set → read round-trips; clear removes it; scoped per provider', async () => {
    const { setOAuthFlow, readOAuthFlow, clearOAuthFlow } = await import('@/lib/auth/oauth/oauthState')
    await setOAuthFlow('google', { state: 'S', codeVerifier: 'V', returnTo: '/x' })
    expect(await readOAuthFlow('google')).toEqual({ state: 'S', codeVerifier: 'V', returnTo: '/x' })
    expect(await readOAuthFlow('github')).toBeNull()
    const opts = cookieJar.get('sl_oauth_google')?.options as { httpOnly?: boolean; sameSite?: string } | undefined
    expect(opts?.httpOnly).toBe(true)
    expect(opts?.sameSite).toBe('lax') // survives the provider→callback top-level redirect
    await clearOAuthFlow('google')
    expect(await readOAuthFlow('google')).toBeNull()
  })

  it('returns null on a malformed cookie', async () => {
    cookieJar.set('sl_oauth_google', 'not-json')
    const { readOAuthFlow } = await import('@/lib/auth/oauth/oauthState')
    expect(await readOAuthFlow('google')).toBeNull()
  })
})
