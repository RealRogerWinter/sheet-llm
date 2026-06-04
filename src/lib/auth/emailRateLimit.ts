/**
 * Outbound-email abuse controls — SEPARATE from the per-IP/-email AUTH limiter
 * (`authRateLimit`). Three sliding windows, all in-process + globalThis-cached
 * (HMR-safe), mirroring authRateLimit's design:
 *   - per-DESTINATION: caps mail to one address (reset/verify bombing a victim).
 *   - per-IP: caps how much mail one client can trigger.
 *   - instance-wide BUDGET: a hard ceiling so a signup flood can't torch the
 *     sending domain's reputation and break reset deliverability for everyone.
 * `checkEmailSend` records on success ONLY; a blocked send records nothing.
 * Single-process: behind N nodes each budget is per-node — the Redis swap is the
 * same documented P1 as authRateLimit.
 */
const DEST_WINDOW_MS = 60 * 60 * 1000 // 1h
const DEST_LIMIT = 5
const IP_WINDOW_MS = 60 * 60 * 1000 // 1h
const IP_LIMIT = 15
const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h
const GLOBAL_LIMIT = 1000
const MAX_ENTRIES = 20_000
const GLOBAL_KEY = '*'

interface Bucket {
  hits: number[]
}

declare global {
  // global augmentation requires `var` (let/const don't attach to globalThis)
  var __sheetllm_email_rate:
    | { dest: Map<string, Bucket>; ip: Map<string, Bucket>; global: Map<string, Bucket> }
    | undefined
}

function getStore() {
  if (!globalThis.__sheetllm_email_rate) {
    globalThis.__sheetllm_email_rate = { dest: new Map(), ip: new Map(), global: new Map() }
  }
  return globalThis.__sheetllm_email_rate
}

/** Is `key` under `limit` within the window? Prunes stale hits as a side effect. */
function withinLimit(
  bucket: Map<string, Bucket>,
  key: string,
  windowMs: number,
  limit: number,
): boolean {
  const cutoff = Date.now() - windowMs
  const existing = bucket.get(key)
  if (existing) {
    existing.hits = existing.hits.filter((t) => t >= cutoff)
    return existing.hits.length < limit
  }
  // Unknown key is under-limit UNLESS the map is saturated (fail-closed).
  return bucket.size < MAX_ENTRIES
}

function record(bucket: Map<string, Bucket>, key: string): void {
  const existing = bucket.get(key)
  if (existing) existing.hits.push(Date.now())
  else if (bucket.size < MAX_ENTRIES) bucket.set(key, { hits: [Date.now()] })
}

function retryAfter(windowMs: number): number {
  return Math.ceil(windowMs / 1000)
}

/**
 * Reserve ONE outbound send for (destination email, client IP). Returns ok and
 * records all three windows, or `{ ok: false, retryAfterSec }` (recording
 * nothing) when any window is full. Checks the shared budget first, then IP,
 * then destination.
 */
export function checkEmailSend(input: { email: string; ip: string }): {
  ok: boolean
  retryAfterSec?: number
} {
  const store = getStore()
  if (!withinLimit(store.global, GLOBAL_KEY, GLOBAL_WINDOW_MS, GLOBAL_LIMIT)) {
    return { ok: false, retryAfterSec: retryAfter(GLOBAL_WINDOW_MS) }
  }
  if (!withinLimit(store.ip, input.ip, IP_WINDOW_MS, IP_LIMIT)) {
    return { ok: false, retryAfterSec: retryAfter(IP_WINDOW_MS) }
  }
  if (!withinLimit(store.dest, input.email, DEST_WINDOW_MS, DEST_LIMIT)) {
    return { ok: false, retryAfterSec: retryAfter(DEST_WINDOW_MS) }
  }
  record(store.global, GLOBAL_KEY)
  record(store.ip, input.ip)
  record(store.dest, input.email)
  return { ok: true }
}

/** Test-only: clear all buckets. */
export function __resetEmailRateForTesting(): void {
  globalThis.__sheetllm_email_rate = undefined
}
