import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  computeDeadlineAt,
  remainingMs,
  isDeadlineApproaching,
} from '@/lib/orchestrator/deadline'

describe('orchestrator/deadline', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('computeDeadlineAt defaults to now + 55_000 ms', () => {
    const before = Date.now()
    const d = computeDeadlineAt()
    expect(d - before).toBeGreaterThanOrEqual(54_900)
    expect(d - before).toBeLessThanOrEqual(55_100)
  })

  it('computeDeadlineAt honors DEADLINE_MS env override', () => {
    vi.stubEnv('DEADLINE_MS', '30000')
    const d = computeDeadlineAt()
    const delta = d - Date.now()
    expect(delta).toBeGreaterThanOrEqual(29_900)
    expect(delta).toBeLessThanOrEqual(30_100)
  })

  it('ignores invalid DEADLINE_MS (falls back to default)', () => {
    vi.stubEnv('DEADLINE_MS', 'not-a-number')
    const d = computeDeadlineAt()
    const delta = d - Date.now()
    expect(delta).toBeGreaterThanOrEqual(54_900)
  })

  it('remainingMs computes the gap to the deadline', () => {
    const d = Date.now() + 5_000
    const r = remainingMs(d)
    expect(r).toBeGreaterThanOrEqual(4_900)
    expect(r).toBeLessThanOrEqual(5_100)
  })

  it('remainingMs returns 0 (not negative) when past deadline', () => {
    const d = Date.now() - 1_000
    expect(remainingMs(d)).toBe(0)
  })

  it('isDeadlineApproaching: true when estimated call exceeds remaining budget', () => {
    const d = Date.now() + 2_000
    expect(isDeadlineApproaching(d, 5_000)).toBe(true)
  })

  it('isDeadlineApproaching: false when call fits within remaining budget', () => {
    const d = Date.now() + 10_000
    expect(isDeadlineApproaching(d, 2_000)).toBe(false)
  })

  it('isDeadlineApproaching with no estimate: defaults to false when at least 1s remains', () => {
    const d = Date.now() + 2_000
    expect(isDeadlineApproaching(d)).toBe(false)
  })

  it('isDeadlineApproaching with no estimate: true when < 1s remains', () => {
    const d = Date.now() + 500
    expect(isDeadlineApproaching(d)).toBe(true)
  })
})
