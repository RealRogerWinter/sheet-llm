// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertJournalModeForReplication,
  isDatabaseLocked,
  isReplicationConfigured,
  migrateWithRetry,
} from '@/lib/db/durability'

afterEach(() => vi.unstubAllEnvs())

describe('isReplicationConfigured', () => {
  it('true when a replica URL or SL_REQUIRE_WAL=1 is set, false otherwise', () => {
    expect(isReplicationConfigured()).toBe(false)
    vi.stubEnv('SL_REQUIRE_WAL', '1')
    expect(isReplicationConfigured()).toBe(true)
    vi.unstubAllEnvs()
    vi.stubEnv('LITESTREAM_REPLICA_URL', 's3://bucket/sheet-llm')
    expect(isReplicationConfigured()).toBe(true)
  })
})

describe('assertJournalModeForReplication', () => {
  it('throws FATAL when replication is configured but the mode is not wal', () => {
    vi.stubEnv('SL_REQUIRE_WAL', '1')
    expect(() => assertJournalModeForReplication('delete')).toThrow(/FATAL/)
    expect(() => assertJournalModeForReplication('memory')).toThrow(/wal/i)
  })
  it('passes when the mode is wal', () => {
    vi.stubEnv('SL_REQUIRE_WAL', '1')
    expect(() => assertJournalModeForReplication('wal')).not.toThrow()
  })
  it('does NOT gate when replication is unconfigured, even on a non-wal mode', () => {
    expect(() => assertJournalModeForReplication('delete')).not.toThrow()
  })
})

describe('isDatabaseLocked', () => {
  it('matches SQLITE_BUSY by code or message only', () => {
    expect(isDatabaseLocked({ code: 'SQLITE_BUSY' })).toBe(true)
    expect(isDatabaseLocked(new Error('database is locked'))).toBe(true)
    expect(isDatabaseLocked(new Error('near "x": syntax error'))).toBe(false)
    expect(isDatabaseLocked(null)).toBe(false)
  })
})

describe('migrateWithRetry', () => {
  const noSleep = () => {}

  it('succeeds on the first try', () => {
    const run = vi.fn()
    migrateWithRetry(run, { sleep: noSleep })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries a locked error with EXPONENTIAL backoff (delays pinned), then succeeds', () => {
    let calls = 0
    const run = vi.fn(() => {
      calls++
      if (calls < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    })
    const onRetry = vi.fn()
    migrateWithRetry(run, { sleep: noSleep, onRetry, baseDelayMs: 100 })
    expect(run).toHaveBeenCalledTimes(3)
    // 100 * 2**0, 100 * 2**1 — the actual backoff curve, not just the count.
    expect(onRetry.mock.calls).toEqual([
      [1, 100],
      [2, 200],
    ])
  })

  it('caps the backoff at maxDelayMs', () => {
    const run = vi.fn(() => {
      throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })
    })
    const onRetry = vi.fn()
    expect(() =>
      migrateWithRetry(run, { attempts: 4, baseDelayMs: 1000, maxDelayMs: 1500, sleep: noSleep, onRetry }),
    ).toThrow()
    // 1000, min(1500,2000)=1500, min(1500,4000)=1500 — clamped to the cap.
    expect(onRetry.mock.calls).toEqual([
      [1, 1000],
      [2, 1500],
      [3, 1500],
    ])
  })

  it('gives up (throws) after `attempts` consecutive lock errors', () => {
    const run = vi.fn(() => {
      throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })
    })
    expect(() => migrateWithRetry(run, { attempts: 3, sleep: noSleep })).toThrow(/locked/)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('throws a NON-lock error immediately without retrying (a real failure must not be masked)', () => {
    const run = vi.fn(() => {
      throw new Error('migration syntax error')
    })
    expect(() => migrateWithRetry(run, { sleep: noSleep })).toThrow(/syntax/)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
