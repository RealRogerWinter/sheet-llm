/**
 * Per-user + per-IP throttle on Stripe Checkout-session CREATION (hosted
 * billing). The public checkout route would otherwise let a script open
 * sessions in a loop — the cheap front half of card-testing and a way to spam
 * Stripe. Keyed on BOTH the claimed userId (the purchase identity) AND the
 * client IP (catches one host spraying many accounts).
 *
 * Mirrors `orchestrator/requestRateLimit`: single-process, `globalThis`-cached
 * (HMR-safe), `MAX_ENTRIES` fail-closed, env-overridable. Behind N nodes the
 * budget is N× and resets on deploy — a shared-store (Redis) swap is the planned
 * multi-node upgrade, same as the request limiter. This is ONE soft layer: the
 * real payment-fraud controls are Stripe Radar + 3DS at the dashboard (operator
 * launch steps live in the PR-11 description; folded into the billing docs in PR-14).
 *
 * DARK with the rest of billing — the route only calls this when Stripe is on.
 */
import { extractClientIp } from '@/lib/auth/clientIp'

export { extractClientIp }

const WINDOW_MS = 60 * 60 * 1000 // 1 hour
const DEFAULT_USER_LIMIT = 10 // checkout-session creations / hour / claimed user
const DEFAULT_IP_LIMIT = 20 // ... / hour / IP (multi-account from one host)
const DEFAULT_MAX_ENTRIES = 50_000 // store-size cap; SL_CHECKOUT_RATE_MAX_ENTRIES overrides

interface Bucket {
  hits: number[]
}

declare global {
  var __sheetllm_checkout_rate: Map<string, Bucket> | undefined
}

function getStore(): Map<string, Bucket> {
  if (!globalThis.__sheetllm_checkout_rate) {
    globalThis.__sheetllm_checkout_rate = new Map()
  }
  return globalThis.__sheetllm_checkout_rate
}

function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Prune a key's hits to the window in place; return the survivors (or []).
 *  Evicts a bucket that prunes empty so a re-touched expired key doesn't linger
 *  toward MAX_ENTRIES. (Keys never touched again still linger until a periodic
 *  sweep — tracked for PR-13; this keeps the common churn bounded.) */
function prunedHits(store: Map<string, Bucket>, key: string, cutoff: number): number[] {
  const b = store.get(key)
  if (!b) return []
  b.hits = b.hits.filter((t) => t >= cutoff)
  if (b.hits.length === 0) {
    store.delete(key)
    return []
  }
  return b.hits
}

function pushHit(store: Map<string, Bucket>, key: string, now: number): void {
  const b = store.get(key)
  if (b) b.hits.push(now)
  else store.set(key, { hits: [now] })
}

/**
 * Throttle one checkout-creation attempt. Checks the user AND IP windows
 * WITHOUT recording, then records BOTH only if both pass (so a reject on one
 * axis doesn't burn budget on the other). Fail-closed at MAX_ENTRIES.
 */
export function checkCheckoutRate(userId: string, ip: string): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const store = getStore()
  const userKey = `u:${userId}`
  const ipKey = `ip:${ip}`
  const retryAfterSec = Math.ceil(WINDOW_MS / 1000)

  if (
    prunedHits(store, userKey, cutoff).length >= envLimit('SL_CHECKOUT_USER_RATE_LIMIT', DEFAULT_USER_LIMIT) ||
    prunedHits(store, ipKey, cutoff).length >= envLimit('SL_CHECKOUT_IP_RATE_LIMIT', DEFAULT_IP_LIMIT)
  ) {
    return { ok: false, retryAfterSec }
  }

  // Fail closed before allocating new keys so an attacker spraying userIds / IPs
  // can't OOM the process.
  const newKeys = (store.has(userKey) ? 0 : 1) + (store.has(ipKey) ? 0 : 1)
  if (store.size + newKeys > envLimit('SL_CHECKOUT_RATE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES)) {
    return { ok: false, retryAfterSec }
  }

  pushHit(store, userKey, now)
  pushHit(store, ipKey, now)
  return { ok: true }
}

/** Test-only: clear the buckets. */
export function __resetForTesting(): void {
  globalThis.__sheetllm_checkout_rate = undefined
}
