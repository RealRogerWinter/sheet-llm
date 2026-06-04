/**
 * Durability launch gate (PR-11). Litestream streams the SQLite WAL to object
 * storage so a volume wipe / host loss doesn't destroy accounts; it REQUIRES
 * `journal_mode=wal`. This module:
 *   1. promotes a non-WAL journal from a warning to a FATAL boot error WHEN
 *      replication is configured — so the accounts launch can't silently run
 *      unreplicated (every write would be lost on a volume wipe), and
 *   2. wraps the boot `migrate()` in retry-with-backoff so a transient writer
 *      lock (a sibling process still finishing on a deploy crossover) can't
 *      crash-loop the app.
 */

/**
 * Is durable replication expected? True when a Litestream replica destination is
 * configured, or an operator explicitly opts in via `SL_REQUIRE_WAL=1` (the hard
 * launch-gate toggle — set it before flipping accounts on).
 */
export function isReplicationConfigured(): boolean {
  return Boolean(process.env.LITESTREAM_REPLICA_URL) || process.env.SL_REQUIRE_WAL === '1'
}

/**
 * FATAL when replication is configured but the DB isn't in WAL mode. Litestream
 * cannot replicate a non-WAL database, so starting would mean unreplicated
 * (data-loss-on-wipe) writes — we refuse to boot instead.
 */
export function assertJournalModeForReplication(mode: unknown): void {
  if (isReplicationConfigured() && mode !== 'wal') {
    throw new Error(
      `[db] FATAL: replication is configured (LITESTREAM_REPLICA_URL / SL_REQUIRE_WAL) but ` +
        `journal_mode is "${String(mode)}", not "wal". Litestream cannot replicate a ` +
        `non-WAL database — every write would be unreplicated and lost on a volume wipe. ` +
        `WAL needs a writable, non-network local volume; fix the filesystem or unset the ` +
        `replication flag. Refusing to start.`,
    )
  }
}

/** A SQLITE_BUSY / "database is locked" error — the only one worth retrying. */
export function isDatabaseLocked(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const code = (e as { code?: string }).code
  const msg = (e as { message?: string }).message ?? ''
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || /database is locked|SQLITE_BUSY/i.test(msg)
}

/** Block the current thread for `ms` without busy-spinning the CPU. */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface MigrateRetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  onRetry?: (attempt: number, delayMs: number) => void
  /** Injectable for tests; defaults to a real (non-spinning) sync sleep. */
  sleep?: (ms: number) => void
}

/**
 * Run `migrate` (a sync function), retrying ONLY on a database-locked error with
 * exponential backoff (100, 200, 400, … capped). Any other error throws
 * immediately (a real migration failure must not be masked). Throws the last
 * lock error after exhausting attempts. Synchronous + boot-only, so the sync
 * sleep is fine (no requests are being served yet).
 */
export function migrateWithRetry(migrate: () => void, opts: MigrateRetryOptions = {}): void {
  const attempts = opts.attempts ?? 5
  const baseDelay = opts.baseDelayMs ?? 100
  const maxDelay = opts.maxDelayMs ?? 2_000
  const sleep = opts.sleep ?? sleepSync
  // Each iteration either returns (success) or throws (non-lock error, or the
  // final attempt) — so the loop always exits from inside.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      migrate()
      return
    } catch (e) {
      if (!isDatabaseLocked(e) || attempt === attempts - 1) throw e
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt)
      opts.onRetry?.(attempt + 1, delay)
      sleep(delay)
    }
  }
}
