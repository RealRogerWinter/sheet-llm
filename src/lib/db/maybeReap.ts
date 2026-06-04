import {
  reapExpiredAuthSessions,
  reapExpiredAuthTokens,
  reapExpiredQuotaCounters,
  reapOrphanSessions,
  reapStalePartials,
} from '@/lib/db/janitor'

/**
 * Throttled wrapper around `reapStalePartials` for opportunistic
 * invocation from route handlers. Tracks `lastReapAt` in module-local
 * state; if the gap since the last attempt exceeds `intervalMs`,
 * schedules a microtask to reap so the calling request doesn't pay
 * the write-lock latency.
 *
 * Why a microtask vs. the request thread directly: WAL serializes
 * writers. If a deploy or an Anthropic outage leaves 50K stale partials
 * pending, an inline UPDATE could block the request for seconds. The
 * microtask path returns immediately; the reap runs once the current
 * microtask queue drains.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 min

let lastReapAt = 0
let scheduled = false

export function maybeReapStalePartials(
  intervalMs = DEFAULT_INTERVAL_MS,
): void {
  const now = Date.now()
  if (now - lastReapAt < intervalMs) return
  // Update BEFORE scheduling so concurrent calls don't all schedule.
  lastReapAt = now
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    try {
      const { reaped } = reapStalePartials()
      if (reaped > 0) {
        console.warn(`[janitor] reaped ${reaped} stale partials`)
      }
      const { reaped: orphans } = reapOrphanSessions()
      if (orphans > 0) {
        console.warn(`[janitor] reaped ${orphans} orphan user-only sessions`)
      }
    } catch (e) {
      console.error('[janitor] opportunistic reap failed', e)
    }
  })
}

let lastAuthReapAt = 0
let authScheduled = false

/**
 * Opportunistic GC of DEAD auth tokens + sessions, throttled + microtask-
 * deferred exactly like `maybeReapStalePartials`. Call from auth routes so the
 * account tables get swept even on instances that see little chat traffic.
 */
export function maybeReapAuth(intervalMs = DEFAULT_INTERVAL_MS): void {
  const now = Date.now()
  if (now - lastAuthReapAt < intervalMs) return
  lastAuthReapAt = now
  if (authScheduled) return
  authScheduled = true
  queueMicrotask(() => {
    authScheduled = false
    try {
      const { reaped: tokens } = reapExpiredAuthTokens()
      const { reaped: sessions } = reapExpiredAuthSessions()
      if (tokens > 0 || sessions > 0) {
        console.warn(`[janitor] reaped ${tokens} auth tokens + ${sessions} auth sessions`)
      }
    } catch (e) {
      console.error('[janitor] opportunistic auth reap failed', e)
    }
  })
}

let lastQuotaReapAt = 0
let quotaScheduled = false

/**
 * Opportunistic GC of fully-expired daily-quota counters, throttled + microtask-
 * deferred exactly like `maybeReapStalePartials`. Call from the chat route ONLY
 * when the quota feature is enabled (the caller guards on isDailyQuotaEnabled) so
 * a self-hosted instance with the flag off pays nothing. Also runs at boot
 * (instrumentation.ts) so a quiet/redeployed instance still sweeps the IP-PII rows.
 */
export function maybeReapStaleQuota(intervalMs = DEFAULT_INTERVAL_MS): void {
  const now = Date.now()
  if (now - lastQuotaReapAt < intervalMs) return
  lastQuotaReapAt = now
  if (quotaScheduled) return
  quotaScheduled = true
  queueMicrotask(() => {
    quotaScheduled = false
    try {
      const { reaped } = reapExpiredQuotaCounters()
      if (reaped > 0) {
        console.warn(`[janitor] reaped ${reaped} expired quota counters`)
      }
    } catch (e) {
      console.error('[janitor] opportunistic quota reap failed', e)
    }
  })
}

/** Test-only: reset module state. */
export function __resetForTesting(): void {
  lastReapAt = 0
  scheduled = false
  lastAuthReapAt = 0
  authScheduled = false
  lastQuotaReapAt = 0
  quotaScheduled = false
}
