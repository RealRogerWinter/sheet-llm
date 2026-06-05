import { isPaidGenerationEnabled } from '@/lib/auth/account'
import { reapStaleCheckoutBuckets } from './checkoutRateLimit'
import { isStripeEnabled } from './stripe'
import { reapExpiredHolds } from './wallet'
import { pruneStripeEvents, reconcileStripeEvents } from './webhookProcess'

/**
 * In-process BILLING SCHEDULER (PR-13). The deployment is a SINGLE long-lived
 * containerized Node process (better-sqlite3 + Litestream — not serverless, not
 * multi-node), so the credit-billing janitors run on an in-process interval,
 * mirroring the boot janitors already in instrumentation.ts, rather than via an
 * external cron or a new admin endpoint. Jobs:
 *
 *  - reapExpiredHolds — release credit holds stranded by a crash between
 *    placeHold and settle/release (otherwise the user's reserved credits look
 *    permanently stuck). Gated on isPaidGenerationEnabled. Also runs
 *    opportunistically from the chat route; this guarantees a sweep even on a
 *    quiet instance and at boot.
 *  - reconcileStripeEvents — re-process inbox events stuck at 'received' /
 *    'failed'. A webhook whose grant transiently fails still returns 200 to
 *    Stripe (so Stripe will NOT retry), making this the ONLY automatic heal path
 *    for a paid-but-not-granted purchase. Gated on isStripeEnabled.
 *  - pruneStripeEvents — drop aged terminal-good inbox rows (raw-PII retention).
 *  - reapStaleCheckoutBuckets — evict cold keys from the checkout rate-limit map.
 *
 * Each job is independently try/caught: one failure never blocks the others or
 * crashes the process. Each tick RE-READS the flags, so a subsystem turned OFF at
 * runtime stops being swept on the next tick. The scheduler itself only starts at
 * boot, and only if at least one subsystem is enabled then — so newly ENABLING
 * billing takes effect on the next process start (on the container deploy model an
 * env change IS a restart, which re-runs the boot start). A self-host instance
 * with neither subsystem enabled starts NO timer and pays nothing.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 min

function envIntervalMs(): number {
  const n = Number(process.env.SL_BILLING_JANITOR_INTERVAL_MS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INTERVAL_MS
}

export interface BillingJanitorReport {
  holdsReleased: number
  reconcile: { scanned: number; healed: number; stillFailing: number } | null
  eventsPruned: number
  checkoutBucketsEvicted: number
}

/**
 * Run every ENABLED billing janitor ONCE. Free of any timer — invoked by the
 * boot sweep, by each interval tick, and directly by the unit tests. Re-reads the
 * flags each call, so a subsystem disabled at runtime is skipped on the next
 * sweep, and isolates each job so it never throws.
 */
export function runBillingJanitorsOnce(): BillingJanitorReport {
  const report: BillingJanitorReport = {
    holdsReleased: 0,
    reconcile: null,
    eventsPruned: 0,
    checkoutBucketsEvicted: 0,
  }

  if (isPaidGenerationEnabled()) {
    try {
      report.holdsReleased = reapExpiredHolds()
      if (report.holdsReleased > 0) {
        console.warn(`[billing-janitor] released ${report.holdsReleased} expired credit holds`)
      }
    } catch (e) {
      console.error('[billing-janitor] hold reap failed', e)
    }
  }

  if (isStripeEnabled()) {
    try {
      const r = reconcileStripeEvents()
      report.reconcile = r
      if (r.healed > 0 || r.stillFailing > 0) {
        console.warn(`[billing-janitor] reconcile: healed ${r.healed}, stillFailing ${r.stillFailing}`)
      }
    } catch (e) {
      console.error('[billing-janitor] stripe reconcile failed', e)
    }
    try {
      report.eventsPruned = pruneStripeEvents()
      if (report.eventsPruned > 0) {
        console.warn(`[billing-janitor] pruned ${report.eventsPruned} aged stripe_events`)
      }
    } catch (e) {
      console.error('[billing-janitor] stripe_events prune failed', e)
    }
    try {
      report.checkoutBucketsEvicted = reapStaleCheckoutBuckets()
    } catch (e) {
      console.error('[billing-janitor] checkout-rate reap failed', e)
    }
  }

  return report
}

declare global {
  var __sheetllm_billing_scheduler: ReturnType<typeof setInterval> | undefined
}

/**
 * Start the scheduler: a boot sweep + an unref'd interval. Idempotent (a second
 * call while a timer is live is a no-op) and HMR-safe via the globalThis handle.
 * Starts NOTHING when neither billing subsystem is enabled, so a free / self-host
 * instance pays nothing. The interval is `.unref()`'d so it never keeps the
 * process alive on shutdown.
 */
export function startBillingScheduler(intervalMs: number = envIntervalMs()): void {
  if (globalThis.__sheetllm_billing_scheduler) return
  if (!isPaidGenerationEnabled() && !isStripeEnabled()) return // self-host: no timer

  // Boot sweep — heal anything stranded while the process was down.
  runBillingJanitorsOnce()

  const handle = setInterval(() => {
    runBillingJanitorsOnce()
  }, intervalMs)
  // `.unref()` exists on Node's Timeout (server runtime); the structural cast
  // keeps this type-safe regardless of how the global setInterval overload
  // resolves, and never holds the event loop open on shutdown.
  ;(handle as { unref?: () => void }).unref?.()
  globalThis.__sheetllm_billing_scheduler = handle
}

/** Test-only: stop + clear the interval. */
export function __stopBillingSchedulerForTesting(): void {
  if (globalThis.__sheetllm_billing_scheduler) {
    clearInterval(globalThis.__sheetllm_billing_scheduler)
    globalThis.__sheetllm_billing_scheduler = undefined
  }
}
