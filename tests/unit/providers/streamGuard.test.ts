import { describe, it, expect } from 'vitest'
import { makeOutputBudgetGuard } from '@/lib/providers/streamGuard'

describe('makeOutputBudgetGuard — streaming output kill-switch', () => {
  it('trips on the output-token budget via the chars/3.5 over-count', () => {
    const guard = makeOutputBudgetGuard({ outputTokenBudget: 2200 })
    // 2200 tokens * 3.5 chars/token = 7700-char threshold.
    expect(guard.shouldAbort(7699)).toBe(false)
    expect(guard.shouldAbort(7700)).toBe(true)
    expect(guard.reason).toBe('output_budget_exceeded')
  })

  it('aborts EARLY (over-counts tokens) so it can never be bypassed by an under-estimate', () => {
    const guard = makeOutputBudgetGuard({ outputTokenBudget: 100, charsPerToken: 3.5 })
    // 100-token budget -> trips at 350 chars; a real 350-char chunk is well
    // under 100 tokens of dense JSON, so the guard fires at or before the true
    // budget, never after.
    expect(guard.shouldAbort(350)).toBe(true)
  })

  it('trips on the wall-clock deadline (injected clock)', () => {
    let t = 1_000
    const guard = makeOutputBudgetGuard({ deadlineAt: 5_000, now: () => t })
    expect(guard.shouldAbort(0)).toBe(false)
    t = 5_000
    expect(guard.shouldAbort(0)).toBe(true)
    expect(guard.reason).toBe('deadline_exceeded')
  })

  it('deadline takes precedence over budget when both would trip', () => {
    const guard = makeOutputBudgetGuard({ outputTokenBudget: 1, deadlineAt: 0, now: () => 10 })
    expect(guard.shouldAbort(100_000)).toBe(true)
    expect(guard.reason).toBe('deadline_exceeded')
  })

  it('never aborts when neither budget nor deadline is set (inert by default)', () => {
    const guard = makeOutputBudgetGuard({})
    expect(guard.shouldAbort(0)).toBe(false)
    expect(guard.shouldAbort(10_000_000)).toBe(false)
    expect(guard.reason).toBe('')
  })
})
