/**
 * SHE-18 PR6 — apply the retention TTL to `training_pairs` consent markers.
 *
 * Calls `trimTrainingPairs(maxAgeDays)` and prints the deletion count.
 * Intended for the same scheduled cadence as `trim:orchestrator-turns`.
 * Idempotent (WHERE captured_at < cutoff, cutoff sweeps forward).
 *
 * Usage:
 *   pnpm trim:training-pairs [--max-age-days <n>]   (default 90)
 *
 * Note: markers also cascade away when their orchestrator_turns row is trimmed;
 * this is the independent (optionally shorter) corpus-retention knob. See
 * docs/subsystems/training-capture.md.
 */
import { ensureMigrationsApplied, getDb } from '@/lib/db'
import { trimTrainingPairs } from '@/lib/training/trainingRetention'

function main(): void {
  const argv = process.argv.slice(2)
  let maxAgeDays = 90
  const i = argv.indexOf('--max-age-days')
  if (i !== -1) {
    const n = Number(argv[i + 1])
    if (!Number.isFinite(n) || n < 0) {
      console.error('--max-age-days requires a non-negative numeric value')
      process.exit(1)
    }
    maxAgeDays = n
  }
  const db = getDb()
  ensureMigrationsApplied(db)
  const deleted = trimTrainingPairs(maxAgeDays, db)
  console.log(`trim: training_pairs deleted=${deleted} (max_age_days=${maxAgeDays})`)
}

const isEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('trim-training-pairs.ts') ||
    process.argv[1].endsWith('trim-training-pairs.js'))
if (isEntry) {
  try {
    main()
  } catch (e) {
    console.error('[trim-training-pairs] error:', e)
    process.exit(1)
  }
}
