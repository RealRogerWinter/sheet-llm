import { reapExpiredHolds } from './wallet'

/**
 * Throttled, microtask-deferred opportunistic GC of EXPIRED credit holds —
 * mirrors `maybeReapStalePartials` (src/lib/db/maybeReap.ts). A process crash
 * between `placeHold` and settle/release would otherwise strand the user's
 * reserved credits indefinitely (there is no other reaper), presenting as a
 * stuck balance. Call from the chat route ONLY when the paid path is enabled
 * (the caller guards on `isPaidGenerationEnabled`) so a free / self-hosted
 * instance pays nothing.
 *
 * Microtask (not inline) so the calling request never pays the write-lock
 * latency; throttled so concurrent requests don't all schedule a sweep.
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 min

let lastReapAt = 0
let scheduled = false

export function maybeReapExpiredHolds(intervalMs = DEFAULT_INTERVAL_MS): void {
  const now = Date.now()
  if (now - lastReapAt < intervalMs) return
  // Update BEFORE scheduling so concurrent calls don't all schedule.
  lastReapAt = now
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    try {
      const released = reapExpiredHolds()
      if (released > 0) {
        console.warn(`[janitor] released ${released} expired credit holds`)
      }
    } catch (e) {
      console.error('[janitor] opportunistic credit-hold reap failed', e)
    }
  })
}

/** Test-only: reset module state. */
export function __resetHoldReapForTesting(): void {
  lastReapAt = 0
  scheduled = false
}
