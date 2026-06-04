// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (n: string) => map.get(n),
    set: (n: string, v: string, o?: unknown) => map.set(n, { name: n, value: v, options: o }),
    has: (n: string) => map.has(n),
    delete: (n: string) => map.delete(n),
    _reset: () => map.clear(),
  }
})()
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }))

beforeEach(() => cookieJar._reset())

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/auth/login', { method: 'POST', headers })
}

describe('isSameOriginStrict', () => {
  it('accepts a matching Origin host', async () => {
    const { isSameOriginStrict } = await import('@/lib/auth/httpGuards')
    expect(isSameOriginStrict(req({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true)
  })
  it('rejects a cross-origin Origin', async () => {
    const { isSameOriginStrict } = await import('@/lib/auth/httpGuards')
    expect(isSameOriginStrict(req({ origin: 'http://evil.example', host: 'localhost:3000' }))).toBe(false)
  })
  it('rejects a malformed Origin', async () => {
    const { isSameOriginStrict } = await import('@/lib/auth/httpGuards')
    expect(isSameOriginStrict(req({ origin: 'not a url', host: 'localhost:3000' }))).toBe(false)
  })
  it('FAILS CLOSED when Origin is absent and Sec-Fetch-Site is missing', async () => {
    const { isSameOriginStrict } = await import('@/lib/auth/httpGuards')
    expect(isSameOriginStrict(req({ host: 'localhost:3000' }))).toBe(false)
  })
  it('accepts an Origin-less request only with Sec-Fetch-Site: same-origin', async () => {
    const { isSameOriginStrict } = await import('@/lib/auth/httpGuards')
    expect(isSameOriginStrict(req({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }))).toBe(true)
    // cross-site, same-site (sibling subdomain), and none (address-bar nav) reject.
    for (const s of ['cross-site', 'same-site', 'none']) {
      expect(isSameOriginStrict(req({ host: 'localhost:3000', 'sec-fetch-site': s }))).toBe(false)
    }
  })
})

describe('isJsonRequest', () => {
  it('accepts application/json (case-insensitive, with or without params)', async () => {
    const { isJsonRequest } = await import('@/lib/auth/httpGuards')
    expect(isJsonRequest(req({ 'content-type': 'application/json' }))).toBe(true)
    expect(isJsonRequest(req({ 'content-type': 'application/json; charset=utf-8' }))).toBe(true)
    expect(isJsonRequest(req({ 'content-type': 'APPLICATION/JSON' }))).toBe(true)
  })
  it('rejects every simple-form content type (the form CSRF vector) and a missing type', async () => {
    const { isJsonRequest } = await import('@/lib/auth/httpGuards')
    expect(isJsonRequest(req({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false)
    expect(isJsonRequest(req({ 'content-type': 'multipart/form-data; boundary=x' }))).toBe(false)
    expect(isJsonRequest(req({ 'content-type': 'text/plain' }))).toBe(false)
    expect(isJsonRequest(req({}))).toBe(false)
  })
})

describe('CSRF double-submit', () => {
  it('issueCsrfToken sets the sl_csrf cookie; verifyCsrf accepts the echoed token', async () => {
    const { issueCsrfToken, verifyCsrf, CSRF_HEADER_NAME, CSRF_COOKIE_NAME } = await import(
      '@/lib/auth/httpGuards'
    )
    const token = await issueCsrfToken()
    const stored = cookieJar.get(CSRF_COOKIE_NAME)
    expect(stored?.value).toBe(token)
    // Double-submit REQUIRES the cookie be JS-readable (non-httpOnly).
    expect((stored?.options as { httpOnly?: boolean })?.httpOnly).toBe(false)
    expect(await verifyCsrf(req({ [CSRF_HEADER_NAME]: token }))).toBe(true)
  })
  it('rejects a wrong header, a missing header, or a missing cookie', async () => {
    const { issueCsrfToken, verifyCsrf, CSRF_HEADER_NAME } = await import('@/lib/auth/httpGuards')
    const token = await issueCsrfToken()
    expect(await verifyCsrf(req({ [CSRF_HEADER_NAME]: token + 'x' }))).toBe(false)
    expect(await verifyCsrf(req({}))).toBe(false)
    cookieJar._reset()
    expect(await verifyCsrf(req({ [CSRF_HEADER_NAME]: token }))).toBe(false)
  })
})

describe('security headers (next.config)', () => {
  it('emits clickjacking + nosniff + referrer headers app-wide', async () => {
    const cfg = (await import('../../../next.config')).default as {
      headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>
    }
    const groups = (await cfg.headers?.()) ?? []
    const all = groups.flatMap((g) => g.headers)
    const byKey = Object.fromEntries(all.map((h) => [h.key, h.value]))
    expect(byKey['X-Frame-Options']).toBe('DENY')
    expect(byKey['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(byKey['X-Content-Type-Options']).toBe('nosniff')
    expect(byKey['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(byKey['Permissions-Policy']).toContain('camera=()')
  })
})

describe('HSTS env-gating (next.config)', () => {
  it('includes HSTS by default, omits it in localhost-HTTP dev (SL_INSECURE_COOKIE_OK=1)', async () => {
    type Cfg = { headers?: () => Promise<Array<{ headers: Array<{ key: string }> }>> }
    const keys = async (cfg: Cfg): Promise<string[]> =>
      ((await cfg.headers?.()) ?? []).flatMap((g) => g.headers).map((h) => h.key)
    vi.resetModules()
    vi.stubEnv('SL_INSECURE_COOKIE_OK', '')
    const prod = (await import('../../../next.config')).default as Cfg
    expect(await keys(prod)).toContain('Strict-Transport-Security')
    vi.resetModules()
    vi.stubEnv('SL_INSECURE_COOKIE_OK', '1')
    const dev = (await import('../../../next.config')).default as Cfg
    expect(await keys(dev)).not.toContain('Strict-Transport-Security')
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})
