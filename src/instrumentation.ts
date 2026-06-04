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
}
