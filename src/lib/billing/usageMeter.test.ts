import { describe, it, expect } from 'vitest'
import {
  runWithUsageMeter,
  recordProviderCall,
  currentMeterTotals,
  toMicroUsd,
} from './usageMeter'

describe('usageMeter', () => {
  it('accumulates tokens + cost across calls within a scope', async () => {
    const totals = await runWithUsageMeter('req-1', async () => {
      recordProviderCall('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 })
      recordProviderCall('claude-sonnet-4-6', { outputTokens: 1_000_000 })
      return currentMeterTotals()
    })
    expect(totals?.callCount).toBe(2)
    expect(totals?.inputTokens).toBe(1_000_000)
    expect(totals?.outputTokens).toBe(1_000_000)
    expect(totals?.costUsd).toBeCloseTo(3 + 15) // $3 input + $15 output
  })

  it('captures the cache-write bucket in the cost', async () => {
    const totals = await runWithUsageMeter('r', async () => {
      recordProviderCall('claude-sonnet-4-6', { cacheCreationInputTokens: 1_000_000 })
      return currentMeterTotals()
    })
    expect(totals?.cacheCreationInputTokens).toBe(1_000_000)
    expect(totals?.costUsd).toBeCloseTo(3.75) // 1.25x of $3
  })

  it('flags an unpriced model without throwing (tokens kept, cost unchanged)', async () => {
    const totals = await runWithUsageMeter('r', async () => {
      recordProviderCall('some-unpriced-model', { inputTokens: 500, outputTokens: 500 })
      return currentMeterTotals()
    })
    expect(totals?.unpricedCalls).toBe(1)
    expect(totals?.costUsd).toBe(0)
    expect(totals?.inputTokens).toBe(500)
  })

  it('clamps a malformed usage value (NaN / negative / fractional) to 0', async () => {
    const totals = await runWithUsageMeter('r', async () => {
      recordProviderCall('claude-sonnet-4-6', {
        inputTokens: Number.NaN,
        outputTokens: -100,
        cacheCreationInputTokens: 1.5,
      })
      return currentMeterTotals()
    })
    expect(totals?.inputTokens).toBe(0)
    expect(totals?.outputTokens).toBe(0)
    expect(totals?.cacheCreationInputTokens).toBe(0)
    expect(totals?.costUsd).toBe(0)
    expect(totals?.callCount).toBe(1)
  })

  it('is a no-op outside a meter scope (never throws)', () => {
    expect(() => recordProviderCall('claude-sonnet-4-6', { inputTokens: 100 })).not.toThrow()
    expect(currentMeterTotals()).toBeUndefined()
  })

  it('isolates concurrent request scopes (AsyncLocalStorage)', async () => {
    const [a, b] = await Promise.all([
      runWithUsageMeter('a', async () => {
        recordProviderCall('claude-sonnet-4-6', { inputTokens: 1_000_000 })
        await Promise.resolve()
        return currentMeterTotals()?.inputTokens
      }),
      runWithUsageMeter('b', async () => {
        recordProviderCall('claude-sonnet-4-6', { inputTokens: 2_000_000 })
        await Promise.resolve()
        return currentMeterTotals()?.inputTokens
      }),
    ])
    expect(a).toBe(1_000_000)
    expect(b).toBe(2_000_000)
  })

  it('toMicroUsd rounds USD to integer micro-USD', () => {
    expect(toMicroUsd(0.09)).toBe(90_000)
    expect(toMicroUsd(0.0000004)).toBe(0)
    expect(toMicroUsd(1)).toBe(1_000_000)
  })
})
