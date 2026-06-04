/**
 * In-memory sliding-window rate limiting for the auth routes (signup / login /
 * forgot). Mirrors `restoreRateLimit`'s design — single-process, globalThis-
 * cached (HMR-safe), lazy-prune, MAX_ENTRIES fail-closed. Two layers:
 *  - per-IP: throttles ALL auth attempts (DoS / spray speedbump).
 *  - per-email FAILED-login window: a credential-stuffing brake on one account.
 *    Recorded on FAILURE only, so a correct password is never blocked by it.
 *
 * Single-process: behind N nodes the budget is N×. A Redis swap is the
 * documented P1 (single-region v1). The client IP is pinned via
 * `TRUSTED_PROXY_HOPS` (set it in prod); unset → leftmost XFF (legacy,
 * spoofable — documented).
 */

const IP_WINDOW_MS = 5 * 60 * 1000
const IP_LIMIT = 20
const EMAIL_WINDOW_MS = 15 * 60 * 1000
const EMAIL_FAIL_LIMIT = 8
const MAX_ENTRIES = 20_000

interface Bucket {
  hits: number[]
}

declare global {
  // global augmentation requires `var` (let/const don't attach to globalThis)
  var __sheetllm_auth_rate:
    | { ip: Map<string, Bucket>; emailFail: Map<string, Bucket> }
    | undefined
}

function getStore() {
  if (!globalThis.__sheetllm_auth_rate) {
    globalThis.__sheetllm_auth_rate = { ip: new Map(), emailFail: new Map() }
  }
  return globalThis.__sheetllm_auth_rate
}

function windowed(
  bucket: Map<string, Bucket>,
  key: string,
  windowMs: number,
  limit: number,
  record: boolean,
): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now()
  const cutoff = now - windowMs
  const existing = bucket.get(key)
  if (existing) {
    existing.hits = existing.hits.filter((t) => t >= cutoff)
    if (existing.hits.length >= limit) {
      return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000) }
    }
    if (record) existing.hits.push(now)
    return { ok: true }
  }
  if (bucket.size >= MAX_ENTRIES) {
    return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000) }
  }
  if (record) bucket.set(key, { hits: [now] })
  return { ok: true }
}

/** Per-IP throttle for ANY auth attempt. Records the hit. */
export function checkAuthIp(ip: string): { ok: boolean; retryAfterSec?: number } {
  return windowed(getStore().ip, ip, IP_WINDOW_MS, IP_LIMIT, true)
}

/**
 * Per-email FAILED-login throttle. The login route consults this ONLY on the
 * failure path (AFTER a wrong password), so a correct password is reached first
 * and the legitimate owner can NEVER be locked out by it. Does not record — call
 * `recordEmailFailure` to record. (Brakes credential-stuffing FEEDBACK on one
 * account; the strong per-account defense — CAPTCHA / proof-of-work — is v1.1.)
 */
export function checkEmailThrottle(email: string): {
  ok: boolean
  retryAfterSec?: number
} {
  return windowed(getStore().emailFail, email, EMAIL_WINDOW_MS, EMAIL_FAIL_LIMIT, false)
}

export function recordEmailFailure(email: string): void {
  windowed(getStore().emailFail, email, EMAIL_WINDOW_MS, EMAIL_FAIL_LIMIT, true)
}

function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Best-effort client IP. With `TRUSTED_PROXY_HOPS=N` set, the real client is the
 * Nth `x-forwarded-for` entry from the RIGHT (everything to its left is
 * client-spoofable). Unset → leftmost (legacy; spoofable — set it in prod). IPv6
 * collapses to the /64 so an attacker can't rotate /128s to bypass per-IP limits.
 */
export function extractClientIp(request: Request): string {
  const hops = trustedProxyHops()
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 0) {
      if (hops <= 0) return normalizeIp(parts[0]) // unset → leftmost (spoofable)
      if (parts.length >= hops) return normalizeIp(parts[parts.length - hops])
      // Misconfigured (hops > actual XFF depth): do NOT trust the spoofable
      // leftmost — fall through to a single shared bucket (fail-closed).
    }
  }
  return normalizeIp(request.headers.get('x-real-ip') || 'local')
}

function normalizeIp(ip: string): string {
  if (ip.includes(':') && !ip.includes('.')) {
    const groups = ip.split(':')
    if (groups.length > 4) return groups.slice(0, 4).join(':') + '::/64'
  }
  return ip
}

/** Test-only: clear all buckets. */
export function __resetForTesting(): void {
  globalThis.__sheetllm_auth_rate = undefined
}
