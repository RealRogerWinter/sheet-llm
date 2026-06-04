import { describe, it, expect, beforeEach } from 'vitest'

describe('orchestrator/budget', () => {
  beforeEach(async () => {
    const { _resetBudget } = await import('@/lib/orchestrator/budget')
    _resetBudget()
  })

  it('starts with zero usage for an unseen chat', async () => {
    const { getSessionUsage } = await import('@/lib/orchestrator/budget')
    expect(getSessionUsage('chat-1')).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('accumulates usage across recordUsage calls', async () => {
    const { recordUsage, getSessionUsage } = await import('@/lib/orchestrator/budget')
    recordUsage('chat-1', 100, 50)
    recordUsage('chat-1', 200, 75)
    expect(getSessionUsage('chat-1')).toEqual({ inputTokens: 300, outputTokens: 125 })
  })

  it('isolates per-chat usage', async () => {
    const { recordUsage, getSessionUsage } = await import('@/lib/orchestrator/budget')
    recordUsage('chat-a', 100, 50)
    recordUsage('chat-b', 9999, 9999)
    expect(getSessionUsage('chat-a')).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('exceedsBudget is false under the default budget', async () => {
    const { exceedsBudget, recordUsage } = await import('@/lib/orchestrator/budget')
    recordUsage('chat-1', 1000, 500)
    expect(exceedsBudget('chat-1')).toBe(false)
  })

  it('exceedsBudget is true past the configured cap', async () => {
    const { exceedsBudget, recordUsage, _setBudgetCap } = await import('@/lib/orchestrator/budget')
    _setBudgetCap({ inputTokens: 1000, outputTokens: 1000 })
    recordUsage('chat-1', 1500, 0)
    expect(exceedsBudget('chat-1')).toBe(true)
  })

  it('output-token overrun also trips the budget', async () => {
    const { exceedsBudget, recordUsage, _setBudgetCap } = await import('@/lib/orchestrator/budget')
    _setBudgetCap({ inputTokens: 100000, outputTokens: 1000 })
    recordUsage('chat-1', 100, 1500)
    expect(exceedsBudget('chat-1')).toBe(true)
  })

  it('budget cap honors ORCHESTRATOR_BUDGET_INPUT_TOKENS env var when set', async () => {
    process.env.ORCHESTRATOR_BUDGET_INPUT_TOKENS = '500'
    try {
      const { _resetBudget, exceedsBudget, recordUsage } = await import('@/lib/orchestrator/budget')
      _resetBudget()
      recordUsage('chat-1', 600, 0)
      expect(exceedsBudget('chat-1')).toBe(true)
    } finally {
      delete process.env.ORCHESTRATOR_BUDGET_INPUT_TOKENS
    }
  })
})
