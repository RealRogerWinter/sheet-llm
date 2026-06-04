import { describe, expect, it } from 'vitest'
import { CREDIT_PACKS, getPack } from '@/lib/billing/packs'

describe('credit packs', () => {
  it('every amount is an integer (money is never a float)', () => {
    for (const p of CREDIT_PACKS) {
      expect(Number.isInteger(p.priceUsdCents)).toBe(true)
      expect(Number.isInteger(p.baseCredits)).toBe(true)
      expect(Number.isInteger(p.bonusCredits)).toBe(true)
      expect(Number.isInteger(p.totalCredits)).toBe(true)
    }
  })

  it('base credits equal the price in cents (1 credit = 1¢)', () => {
    for (const p of CREDIT_PACKS) expect(p.baseCredits).toBe(p.priceUsdCents)
  })

  it('total = base + bonus', () => {
    for (const p of CREDIT_PACKS) expect(p.totalCredits).toBe(p.baseCredits + p.bonusCredits)
  })

  it('matches the locked catalog: $5 / $10 / $20 / $50 with escalating bonus', () => {
    expect(CREDIT_PACKS.map((p) => [p.priceUsdCents, p.totalCredits])).toEqual([
      [500, 500],
      [1000, 1050],
      [2000, 2200],
      [5000, 5750],
    ])
  })

  it('the minimum pack is $5 and the bonus RATE is non-decreasing by price', () => {
    const sorted = [...CREDIT_PACKS].sort((a, b) => a.priceUsdCents - b.priceUsdCents)
    expect(sorted[0].priceUsdCents).toBe(500)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].bonusCredits / sorted[i - 1].baseCredits
      const cur = sorted[i].bonusCredits / sorted[i].baseCredits
      expect(cur).toBeGreaterThanOrEqual(prev)
    }
  })

  it('ids are unique and resolvable', () => {
    const ids = CREDIT_PACKS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(getPack(id)?.id).toBe(id)
    expect(getPack('nope')).toBeUndefined()
  })
})
