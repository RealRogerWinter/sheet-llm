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

// Client-IP extraction lives in one shared module — `@/lib/http/clientIp` —
// which adds CF-Connecting-IP (the trusted source behind Cloudflare) on top of
// the hop-aware X-Forwarded-For logic. Re-exported here so existing imports
// (`@/lib/auth/authRateLimit`) keep working unchanged.
export { extractClientIp } from '@/lib/http/clientIp'

/** Test-only: clear all buckets. */
export function __resetForTesting(): void {
  globalThis.__sheetllm_auth_rate = undefined
}
