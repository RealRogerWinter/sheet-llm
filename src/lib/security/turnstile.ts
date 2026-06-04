import { cookies } from 'next/headers'
import crypto from 'node:crypto'
import { extractClientIp } from '@/lib/auth/clientIp'

/**
 * Cloudflare Turnstile bot-gate for the LLM-cost routes (`/api/chat`,
 * `/api/import`). A client passes the Turnstile challenge once; the server
 * verifies the token with Cloudflare and issues a short-lived, **IP-bound,
 * HMAC-signed** clearance cookie; the cost routes require that cookie. This
 * blocks automated clients from ever reaching the token-burning endpoints,
 * layered on top of the per-IP rate limiter, the bounded free tier, and the
 * Anthropic spend cap.
 *
 * Feature is ON only when BOTH `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
 * are set — otherwise `hasClearance` returns true (no gating), so dev/test/stub
 * and any non-Turnstile deploy are unchanged.
 *
 * The clearance cookie is signed with `SESSION_SECRET` (domain-separated), so no
 * new secret is required; the IP comes from `CF-Connecting-IP` (clientIp.ts) so a
 * token solved by one client can't be replayed across a botnet.
 */

const CLEAR_COOKIE = 'sl_bot_clear'
const CLEAR_TTL_SEC = 30 * 60
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function isTurnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY)
}

function signingKey(): string {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET (>=32 bytes) is required to sign Turnstile clearance')
  }
  return s
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', signingKey()).update('turnstile-clear:' + payloadB64).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/** PURE (testable): build a signed clearance value bound to `ip`, valid CLEAR_TTL_SEC. */
export function makeClearanceValue(ip: string, nowMs: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(nowMs / 1000) + CLEAR_TTL_SEC, ip }),
  ).toString('base64url')
  return payload + '.' + sign(payload)
}

/** PURE (testable): true iff `value` is a valid, unexpired clearance for `ip`. */
export function checkClearanceValue(value: string, ip: string, nowMs: number = Date.now()): boolean {
  const dot = value.indexOf('.')
  if (dot <= 0) return false
  const payloadB64 = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  if (!safeEqual(mac, sign(payloadB64))) return false
  let p: { exp?: unknown; ip?: unknown }
  try {
    p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
  } catch {
    return false
  }
  if (typeof p.exp !== 'number' || p.exp < Math.floor(nowMs / 1000)) return false
  return p.ip === ip
}

/** Verify a Turnstile token with Cloudflare's siteverify endpoint. */
export async function verifyTurnstileToken(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret || !token) return false
  try {
    const body = new URLSearchParams({ secret, response: token })
    if (ip && ip !== 'local') body.set('remoteip', ip)
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

/** Set the clearance cookie after a passed challenge (call from /api/turnstile). */
export async function issueClearance(request: Request): Promise<void> {
  const store = await cookies()
  store.set(CLEAR_COOKIE, makeClearanceValue(extractClientIp(request)), {
    httpOnly: true,
    secure: process.env.SL_INSECURE_COOKIE_OK !== '1',
    sameSite: 'lax',
    path: '/',
    maxAge: CLEAR_TTL_SEC,
  })
}

/** Gate check for the cost routes. True (allow) when Turnstile is disabled. */
export async function hasClearance(request: Request): Promise<boolean> {
  if (!isTurnstileEnabled()) return true
  const store = await cookies()
  const value = store.get(CLEAR_COOKIE)?.value
  if (!value) return false
  return checkClearanceValue(value, extractClientIp(request))
}
