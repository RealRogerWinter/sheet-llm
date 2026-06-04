import { describe, it, expect } from 'vitest'
import {
  PRICING,
  billableCostUsd,
  estimateCostUsd,
  UnknownModelPricingError,
  InvalidUsageError,
} from './pricing'

const NO_CACHE = { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

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

  it('derives cache rates from base input (read 0.1x, write 1.25x)', () => {
    for (const p of Object.values(PRICING)) {
      expect(p.cachedInputPerM).toBeCloseTo(p.inputPerM * 0.1)
      expect(p.cacheWrite5mPerM).toBeCloseTo(p.inputPerM * 1.25)
    }
  })

  describe('billableCostUsd (strict, for debits)', () => {
    it('bills uncached input + output at base rates', () => {
      const c = billableCostUsd('claude-sonnet-4-6', {
        uncachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        ...NO_CACHE,
      })
      expect(c).toBeCloseTo(18) // $3 + $15
    })

    it('bills cache-creation (write) tokens ABOVE the base input rate', () => {
      const withWrite = billableCostUsd('claude-sonnet-4-6', {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
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
        cacheCreationInputTokens: 0,
      })
      expect(c).toBeCloseTo(0.3)
    })

    it('THROWS on an unpriced model — never a silent $0 debit', () => {
      expect(() =>
        billableCostUsd('some-other-provider-model', {
          uncachedInputTokens: 1000,
          outputTokens: 1000,
          ...NO_CACHE,
        }),
      ).toThrow(UnknownModelPricingError)
    })

    it.each([
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['fractional', 1.5],
    ])('THROWS InvalidUsageError on a %s input count (fails closed)', (_label, bad) => {
      expect(() =>
        billableCostUsd('claude-sonnet-4-6', {
          uncachedInputTokens: bad as number,
          outputTokens: 0,
          ...NO_CACHE,
        }),
      ).toThrow(InvalidUsageError)
    })

    it('validates the cache buckets too, not just input/output', () => {
      expect(() =>
        billableCostUsd('claude-sonnet-4-6', {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: -5,
          cacheCreationInputTokens: 0,
        }),
      ).toThrow(InvalidUsageError)
    })
  })

  describe('estimateCostUsd (lenient, evals only)', () => {
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
      const c = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 0, 400_000, 100_000)
      expect(c).toBeCloseTo(1.5 + 0.12 + 0.375) // 500k*3 + 400k*0.3 + 100k*3.75, /1e6
    })

    it('coerces non-finite / negative telemetry to 0 instead of throwing', () => {
      expect(estimateCostUsd('claude-sonnet-4-6', Number.NaN, -10)).toBe(0)
      expect(estimateCostUsd('claude-sonnet-4-6', Number.POSITIVE_INFINITY, 0)).toBe(0)
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
