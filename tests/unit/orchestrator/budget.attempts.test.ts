import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordUsage,
  getSessionUsage,
  _resetBudget,
  withUsageRecording,
} from '@/lib/orchestrator/budget'

describe('orchestrator/budget — recording across attempts', () => {
  beforeEach(() => {
    _resetBudget()
  })

  it('withUsageRecording records usage even when the callback throws', async () => {
    const recordedAttempts: Array<{ inputTokens?: number; outputTokens?: number; attemptIndex: number }> = []
    await expect(
      withUsageRecording('chat-throw', async (attempt) => {
        recordedAttempts.push({ inputTokens: 100, outputTokens: 50, attemptIndex: attempt.attemptIndex })
        attempt.record({ inputTokens: 100, outputTokens: 50 })
        throw new Error('LLM call failed')
      }),
    ).rejects.toThrow('LLM call failed')
    // Budget still reflects the failed attempt's tokens.
    expect(getSessionUsage('chat-throw')).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('withUsageRecording sums multiple attempts in the same chat', async () => {
    // Simulate: 1st attempt records 100/50 then throws; 2nd attempt
    // records 200/75 and succeeds. Total = 300/125.
    await expect(
      withUsageRecording('chat-multi', async (attempt) => {
        attempt.record({ inputTokens: 100, outputTokens: 50 })
        throw new Error('first fail')
      }),
    ).rejects.toThrow()

    await withUsageRecording('chat-multi', async (attempt) => {
      attempt.record({ inputTokens: 200, outputTokens: 75 })
    })

    expect(getSessionUsage('chat-multi')).toEqual({ inputTokens: 300, outputTokens: 125 })
  })

  it('attemptIndex increments across successive calls per chat', async () => {
    const indices: number[] = []
    await withUsageRecording('chat-idx', async (a) => {
      indices.push(a.attemptIndex)
      a.record({ inputTokens: 1, outputTokens: 1 })
    })
    await withUsageRecording('chat-idx', async (a) => {
      indices.push(a.attemptIndex)
      a.record({ inputTokens: 1, outputTokens: 1 })
    })
    expect(indices).toEqual([0, 1])
  })

  it('recordUsage still works (backward compat with direct callers)', () => {
    recordUsage('chat-legacy', 50, 25)
    expect(getSessionUsage('chat-legacy')).toEqual({ inputTokens: 50, outputTokens: 25 })
  })
})
