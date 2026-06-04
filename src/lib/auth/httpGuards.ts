import { cookies } from 'next/headers'
import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * HTTP request guards for the authenticated, non-idempotent routes
 * (login / signup / logout / change-password / change-email / delete — wired in
 * PR-4+). Defence-in-depth on top of httpOnly + SameSite=Lax session cookies.
 */

const CSRF_COOKIE = 'sl_csrf'
const CSRF_HEADER = 'x-csrf-token'

export const CSRF_COOKIE_NAME = CSRF_COOKIE
export const CSRF_HEADER_NAME = 'X-CSRF-Token'

/**
 * STRICT same-origin check — fail-CLOSED, unlike the legacy `checkSameOrigin`
 * (chat/route.ts), which lets an Origin-LESS request through. Requires a
 * POSITIVE same-origin signal: a matching `Origin` host, or — when `Origin` is
 * absent — `Sec-Fetch-Site: same-origin` (every modern browser sends it on
 * fetch/XHR). Neither present → reject. Use as the FIRST check on every mutating
 * auth route.
 */
export function isSameOriginStrict(request: Request): boolean {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin && host) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin'
}

/**
 * True when the request body is declared `application/json`. Auth routes accept
 * ONLY JSON: a cross-site HTML `<form>` can only send urlencoded / multipart /
 * text-plain, so requiring JSON blocks the classic simple-form-POST CSRF vector
 * (which also evades a custom-header requirement).
 */
export function isJsonRequest(request: Request): boolean {
  const ct = request.headers.get('content-type') ?? ''
  return ct.split(';')[0].trim().toLowerCase() === 'application/json'
}

function cookieSecure(): boolean {
  return process.env.SL_INSECURE_COOKIE_OK !== '1'
}

/**
 * Issue a fresh double-submit CSRF token: set it in a non-httpOnly `sl_csrf`
 * cookie (so client JS can echo it) and return it (so an SSR form can embed it
 * too). The client returns it in the `X-CSRF-Token` header; `verifyCsrf`
 * requires header === cookie. A cross-site page can neither READ our cookie
 * (same-origin policy) nor ADD the custom header on a simple cross-site request,
 * so it cannot forge a valid pair.
 */
export async function issueCsrfToken(): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const store = await cookies()
  store.set(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 1 week; re-issued on each auth-surface render
  })
  return token
}

/** Constant-time compare that won't throw on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify the double-submit pair: the `X-CSRF-Token` header must equal the
 * `sl_csrf` cookie (both present + non-empty), compared in constant time.
 * Returns false on any absence / mismatch. Call right AFTER `isSameOriginStrict`
 * on every mutating auth route.
 */
export async function verifyCsrf(request: Request): Promise<boolean> {
  const header = request.headers.get(CSRF_HEADER)
  if (!header) return false
  const store = await cookies()
  const cookie = store.get(CSRF_COOKIE)?.value
  if (!cookie) return false
  return safeEqual(header, cookie)
}
