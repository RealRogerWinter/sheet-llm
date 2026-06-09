/**
 * SHE-8 — per-IP sliding-window rate limit for BYOK (`debug.apiKey`) chat
 * requests, SEPARATE from the token-cost limiter in `requestRateLimit.ts`.
 *
 * Why separate: the main limiter (`SL_REQUEST_IP_RATE_LIMIT`) exists to cap
 * spend on OUR Anthropic key. A BYOK request pays its own provider bill, so it
 * is OFF that money path — but it still consumes OUR shared infra (DB writes,
 * CPU, sockets, the orchestrator pipeline). This independent bucket bounds that
 * abuse without coupling it to the token-spend budget. It only ever runs for a
 * request whose BYOK key was accepted (`isByokKeyAccepted()` — dev/test or an
 * explicit `SL_BYOK_ALLOWED` opt-in), so a hosted demo with BYOK off never hits
 * it. A single-tenant self-host can raise/disable it via the env override.
 *
 * Single-process, `globalThis`-cached (HMR-safe), `MAX_ENTRIES` fail-closed —
 * mirrors `requestRateLimit` / `authRateLimit`. Env-overridable via
 * `SL_BYOK_IP_RATE_LIMIT` (default 30 requests / 5 min / IP; `0` or `off`
 * disables the cap entirely for a single-tenant self-host).
 */
const WINDOW_MS = 5 * 60 * 1000
const DEFAULT_LIMIT = 30
const MAX_ENTRIES = 50_000

interface Bucket {
  hits: number[]
}

declare global {
  var __sheetllm_byok_rate: Map<string, Bucket> | undefined
}

function getStore(): Map<string, Bucket> {
  if (!globalThis.__sheetllm_byok_rate) {
    globalThis.__sheetllm_byok_rate = new Map()
  }
  return globalThis.__sheetllm_byok_rate
}

/** Resolved per-IP cap, or `null` when the operator disabled it outright. */
function ipLimit(): number | null {
  const raw = process.env.SL_BYOK_IP_RATE_LIMIT?.trim().toLowerCase()
  // Self-host escape hatch: explicit `0` / `off` disables the cap entirely. A
  // single-tenant install (the intended BYOK audience) may want no per-IP brake.
  if (raw === '0' || raw === 'off') return null
  const n = Number(process.env.SL_BYOK_IP_RATE_LIMIT)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT
}

/** Per-IP throttle for one BYOK request. Records the hit on success. */
export function checkByokIp(ip: string): { ok: boolean; retryAfterSec?: number } {
  const limit = ipLimit()
  if (limit === null) return { ok: true } // disabled (self-host opt-out)
  const bucket = getStore()
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const existing = bucket.get(ip)
  if (existing) {
    existing.hits = existing.hits.filter((t) => t >= cutoff)
    if (existing.hits.length >= limit) {
      return { ok: false, retryAfterSec: Math.ceil(WINDOW_MS / 1000) }
    }
    existing.hits.push(now)
    return { ok: true }
  }
  // New key — enforce MAX_ENTRIES before allocating so an attacker spraying IPs
  // cannot OOM the process.
  if (bucket.size >= MAX_ENTRIES) {
    return { ok: false, retryAfterSec: Math.ceil(WINDOW_MS / 1000) }
  }
  bucket.set(ip, { hits: [now] })
  return { ok: true }
}

/** Test-only: clear the bucket. */
export function __resetForTesting(): void {
  globalThis.__sheetllm_byok_rate = undefined
}
