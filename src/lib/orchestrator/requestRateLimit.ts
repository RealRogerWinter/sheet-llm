/**
 * Per-IP sliding-window rate limit for the EXPENSIVE non-auth routes
 * (`/api/chat`, `/api/import`).
 *
 * Why: the orchestrator's per-chatId token budget (`budget.ts`) resets the
 * moment a caller rotates `chatId`, and v1 has no per-user metering — so without
 * a per-IP brake an anonymous caller can drive unbounded Anthropic spend. The
 * real client IP comes from `CF-Connecting-IP` behind Cloudflare (see
 * `clientIp.ts`). Defence in depth: pair this with a Cloudflare edge rate-limit
 * rule on these paths AND an Anthropic org-level spend cap.
 *
 * Single-process, `globalThis`-cached (HMR-safe), `MAX_ENTRIES` fail-closed —
 * mirrors `authRateLimit` / `restoreRateLimit`. The limit is env-overridable via
 * `SL_REQUEST_IP_RATE_LIMIT` (default 60 requests / 5 min / IP). Behind N nodes
 * the budget is N× (single-region v1; a Redis swap is the documented P1).
 */
import { extractClientIp } from '@/lib/auth/clientIp'

export { extractClientIp }

const WINDOW_MS = 5 * 60 * 1000
const DEFAULT_LIMIT = 60
const MAX_ENTRIES = 50_000

interface Bucket {
  hits: number[]
}

declare global {
  // eslint-disable-next-line no-var
  var __sheetllm_request_rate: Map<string, Bucket> | undefined
}

function getStore(): Map<string, Bucket> {
  if (!globalThis.__sheetllm_request_rate) {
    globalThis.__sheetllm_request_rate = new Map()
  }
  return globalThis.__sheetllm_request_rate
}

function ipLimit(): number {
  const n = Number(process.env.SL_REQUEST_IP_RATE_LIMIT)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT
}

/** Per-IP throttle for one expensive request. Records the hit on success. */
export function checkRequestIp(ip: string): { ok: boolean; retryAfterSec?: number } {
  const bucket = getStore()
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const limit = ipLimit()
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
  globalThis.__sheetllm_request_rate = undefined
}
