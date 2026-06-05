// Next.js calls `register()` once per server process on startup.
// We use it to apply any pending Drizzle migrations so route handlers
// never see an out-of-date schema. Cheap when there's nothing to do.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { ensureMigrationsApplied } = await import('@/lib/db')
  ensureMigrationsApplied()

  // Reap stale `partial` streaming-message rows left behind by previous
  // process crashes (deploy crossover, OOM, Vercel timeout mid-stream).
  // Wrapped in try/catch: a locked DB at boot (sibling process still
  // holding WAL) is a transient that self-resolves; never crash the
  // server over a janitor failure.
  try {
    const { reapStalePartials } = await import('@/lib/db/janitor')
    const { reaped } = reapStalePartials()
    if (reaped > 0) {
      console.warn(`[boot] janitor reaped ${reaped} stale partials`)
    }
  } catch (e) {
    console.error('[boot] janitor failed; continuing', e)
  }

  // Sweep expired daily-quota counters at boot too, so an instance that has the
  // quota feature ON but sees little chat traffic (or only ever rejects at the
  // gate) still purges the hashed-IP PII rows. Gated by the flag so a self-hosted
  // instance with quota OFF does nothing here.
  try {
    const { isDailyQuotaEnabled } = await import('@/lib/orchestrator/dailyQuota')
    if (isDailyQuotaEnabled()) {
      const { reapExpiredQuotaCounters } = await import('@/lib/db/janitor')
      const { reaped } = reapExpiredQuotaCounters()
      if (reaped > 0) {
        console.warn(`[boot] janitor reaped ${reaped} expired quota counters`)
      }
    }
  } catch (e) {
    console.error('[boot] quota janitor failed; continuing', e)
  }

  // Start the in-process BILLING scheduler (PR-13): a boot sweep + an unref'd
  // interval that reaps expired credit holds and reconciles Stripe webhook grants
  // stuck at 'received'/'failed' (the only automatic heal path for a paid-but-not-
  // granted purchase, since a transiently-failed webhook still returns 200 so
  // Stripe won't retry). Gated INSIDE on the billing flags — a free / self-hosted
  // instance starts no timer. Wrapped so an import/janitor failure never blocks boot.
  try {
    const { startBillingScheduler } = await import('@/lib/billing/scheduler')
    startBillingScheduler()
  } catch (e) {
    console.error('[boot] billing scheduler failed to start; continuing', e)
  }
}
