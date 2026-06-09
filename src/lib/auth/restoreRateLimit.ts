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

// Client-IP extraction is shared with the auth + chat/import limiters — see
// `@/lib/http/clientIp`. Re-exported so `@/lib/auth/restoreRateLimit` imports
// keep working. NOTE: this REPLACES the previous always-leftmost-XFF behavior,
// which was spoofable behind a proxy/CDN (an attacker rotating X-Forwarded-For
// got a fresh per-IP bucket every request). The shared helper honors
// CF-Connecting-IP / TRUSTED_PROXY_HOPS just like the auth limiter.
export { extractClientIp } from '@/lib/http/clientIp'

/** Test-only: clear all buckets. */
export function __resetForTesting(): void {
  globalThis.__sheetllm_restore_rate = undefined
}
