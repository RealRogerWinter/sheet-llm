import { describe, it, expect } from 'vitest'
import {
  PRICING,
  billableCostUsd,
  estimateCostUsd,
  UnknownModelPricingError,
} from './pricing'

describe('billing/pricing', () => {
  it('prices every Anthropic registry model id, including Opus 4.8', () => {
    for (const id of [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
    ]) {
      expect(PRICING[id], `missing pricing for ${id}`).toBeDefined()
    }
  })

  it('derives cache rates from base input (read 0.1x, write 1.25x / 2x)', () => {
    for (const p of Object.values(PRICING)) {
      expect(p.cachedInputPerM).toBeCloseTo(p.inputPerM * 0.1)
      expect(p.cacheWrite5mPerM).toBeCloseTo(p.inputPerM * 1.25)
      expect(p.cacheWrite1hPerM).toBeCloseTo(p.inputPerM * 2)
    }
  })

  describe('billableCostUsd (strict, for debits)', () => {
    it('bills uncached input + output at base rates', () => {
      // 1M uncached input + 1M output on Sonnet = $3 + $15
      const c = billableCostUsd('claude-sonnet-4-6', {
        uncachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
      expect(c).toBeCloseTo(18)
    })

    it('bills cache-creation (write) tokens ABOVE the base input rate', () => {
      const withWrite = billableCostUsd('claude-sonnet-4-6', {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
      })
      expect(withWrite).toBeCloseTo(3.75) // 1.25x of $3
      expect(withWrite).toBeGreaterThan(3) // strictly more than plain input
    })

    it('bills cache-read tokens at 0.1x input', () => {
      const c = billableCostUsd('claude-sonnet-4-6', {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
      })
      expect(c).toBeCloseTo(0.3)
    })

    it('THROWS on an unpriced model — never a silent $0 debit', () => {
      expect(() =>
        billableCostUsd('some-other-provider-model', {
          uncachedInputTokens: 1000,
          outputTokens: 1000,
        }),
      ).toThrow(UnknownModelPricingError)
    })
  })

  describe('estimateCostUsd (lenient, for evals)', () => {
    it('returns 0 on an unknown model — never blocks an eval', () => {
      const prev = process.env.EVAL_SILENT
      process.env.EVAL_SILENT = '1'
      try {
        expect(estimateCostUsd('mystery-model', 1000, 1000)).toBe(0)
      } finally {
        if (prev === undefined) delete process.env.EVAL_SILENT
        else process.env.EVAL_SILENT = prev
      }
    })

    it('treats inputTokens as the TOTAL and subtracts the cached + write subsets', () => {
      // 1M total input = 500k uncached + 400k cache-read + 100k cache-write, 0 output (Sonnet)
      const c = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 0, 400_000, 100_000)
      expect(c).toBeCloseTo(1.5 + 0.12 + 0.375) // 500k*3 + 400k*0.3 + 100k*3.75, /1e6
    })

    it('agrees with billableCostUsd for the same disjoint buckets', () => {
      const est = estimateCostUsd('claude-opus-4-8', 1_000_000, 50_000, 300_000, 200_000)
      const bill = billableCostUsd('claude-opus-4-8', {
        uncachedInputTokens: 500_000, // 1M total - 300k read - 200k write
        outputTokens: 50_000,
        cacheReadInputTokens: 300_000,
        cacheCreationInputTokens: 200_000,
      })
      expect(est).toBeCloseTo(bill)
    })
  })
})
