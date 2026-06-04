/**
 * Apply the 90-day retention TTL to `orchestrator_turns` (M3.5-PR-7).
 *
 * Calls the pure helper `trimOrchestratorTurns(90)` from
 * `src/lib/db/observabilityRetention.ts` and prints the deletion
 * count. Intended to be driven by the weekly GitHub Actions cron
 * (`.github/workflows/retention.yml`).
 *
 * Usage:
 *   pnpm trim:orchestrator-turns
 *
 * Idempotent across re-runs — the WHERE clause is `created_at <
 * cutoff`, so rows already older than the cutoff are removed on the
 * first pass and the cutoff sweeps forward as wall-clock advances.
 */
import { ensureMigrationsApplied, getDb } from '@/lib/db'
import { trimOrchestratorTurns } from '@/lib/db/observabilityRetention'

function main() {
  const db = getDb()
  ensureMigrationsApplied(db)
  const deleted = trimOrchestratorTurns(90, db)
  console.log(`trim: orchestrator_turns deleted=${deleted}`)
}

const isEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('trim-orchestrator-turns.ts') ||
    process.argv[1].endsWith('trim-orchestrator-turns.js'))
if (isEntry) {
  try {
    main()
  } catch (e) {
    console.error('[trim] error:', e)
    process.exit(1)
  }
}
