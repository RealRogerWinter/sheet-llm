/**
 * In-memory sliding-window rate limiter for `/api/auth/restore`.
 *
 * Two buckets:
 *  - per-IP: 10 attempts / 5 min — DoS speedbump
 *  - per-sub (after JWT verification): 10 / 5 min — catches the replay-
 *    from-many-IPs attack the IP bucket alone misses
 *
 * Single-process only. Behind a load balancer with N nodes the budget
 * effectively becomes 10N per window. v1 ships single-region so this
 * is acceptable; Redis swap (Upstash, etc.) flagged for P1.
 *
 * Memory safety:
 *  - Lazy prune on every `check`: drops entries with no in-window hits.
 *  - Hard `MAX_ENTRIES` cap per bucket. When reached we fail-closed
 *    (deny new keys) until the next idle period frees room — an
 *    attacker spraying IPs cannot OOM us.
 *
 * Same module + `globalThis` cache so HMR in dev doesn't spawn parallel
 * timers / buckets.
 */

const WINDOW_MS = 5 * 60 * 1000
const LIMIT = 10
const MAX_ENTRIES = 10_000

interface Bucket {
  // Timestamps (ms) of hits within the current sliding window.
  hits: number[]
}

declare global {
  // eslint-disable-next-line no-var
  var __sheetllm_restore_rate: {
    ip: Map<string, Bucket>
    sub: Map<string, Bucket>
  } | undefined
}

function getStore() {
  if (!globalThis.__sheetllm_restore_rate) {
    globalThis.__sheetllm_restore_rate = {
      ip: new Map(),
      sub: new Map(),
    }
  }
  return globalThis.__sheetllm_restore_rate
}

function pruneAndCheck(bucket: Map<string, Bucket>, key: string): boolean {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const existing = bucket.get(key)
  if (existing) {
    // Drop expired hits in place.
    existing.hits = existing.hits.filter((t) => t >= cutoff)
    if (existing.hits.length >= LIMIT) return false
    existing.hits.push(now)
    return true
  }
  // New key — enforce MAX_ENTRIES before allocating.
  if (bucket.size >= MAX_ENTRIES) {
    // Fail-closed: deny new keys until something expires.
    return false
  }
  bucket.set(key, { hits: [now] })
  return true
}

/**
 * Per-IP check. Pass the client IP (best-effort — first value of
 * `x-forwarded-for`, falling back to a sentinel string for local dev).
 */
export function checkIp(ip: string): { ok: boolean; retryAfterSec?: number } {
  if (pruneAndCheck(getStore().ip, ip)) return { ok: true }
  return { ok: false, retryAfterSec: Math.ceil(WINDOW_MS / 1000) }
}

/**
 * Per-sub (userId) check. Call AFTER JWT verification so forged tokens
 * don't pollute the sub bucket. This is the layer that catches the
 * "single stolen token replayed from a botnet" pattern.
 */
export function checkSub(sub: string): { ok: boolean; retryAfterSec?: number } {
  if (pruneAndCheck(getStore().sub, sub)) return { ok: true }
  return { ok: false, retryAfterSec: Math.ceil(WINDOW_MS / 1000) }
}

/**
 * Extract a client IP from request headers. Production-deployed apps
 * almost always sit behind a proxy that sets `x-forwarded-for`; the
 * leftmost value is the original client. Local dev usually has neither,
 * so we fall back to a literal `'local'` bucket (which means localhost
 * dev gets the same 10/5min budget — still works for any reasonable
 * testing pattern).
 *
 * For IPv6 we hash on the `/64` prefix because each /64 is a single
 * "user" — without this, an attacker on an IPv6 cellular network can
 * pull a fresh /128 per request and bypass per-IP limits trivially.
 */
export function extractClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  const candidate = xff ? xff.split(',')[0].trim() : ''
  const raw = candidate || request.headers.get('x-real-ip') || 'local'
  return normalizeIp(raw)
}

function normalizeIp(ip: string): string {
  // IPv6 /64 prefix collapse — keep only the first 4 groups.
  if (ip.includes(':') && !ip.includes('.')) {
    const groups = ip.split(':')
    if (groups.length > 4) {
      return groups.slice(0, 4).join(':') + '::/64'
    }
  }
  return ip
}

/** Test-only: clear all buckets. */
export function __resetForTesting(): void {
  globalThis.__sheetllm_restore_rate = undefined
}
