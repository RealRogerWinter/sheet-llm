import { describe, expect, it } from 'vitest'
import {
  classifyRefund,
  COST_SPLIT_REFUND_RATIO,
  COST_SPLIT_THRESHOLD_MICRO_USD,
  PER_FAILURE_REFUND_CAP_CREDITS,
} from '@/lib/billing/refundPolicy'

describe('classifyRefund', () => {
  it('never refunds when nothing was charged (hold released)', () => {
    const d = classifyRefund({ finalStatus: 'error', creditsCharged: 0 })
    expect(d).toEqual({ refund: false, reason: 'nothing_charged' })
  })

  it('NEVER refunds a user-initiated abort, even on error', () => {
    const d = classifyRefund({ finalStatus: 'error', creditsCharged: 50, userAborted: true })
    expect(d).toEqual({ refund: false, reason: 'user_aborted' })
  })

  it('does not refund a delivered result (ok)', () => {
    expect(classifyRefund({ finalStatus: 'ok', creditsCharged: 30 })).toEqual({
      refund: false,
      reason: 'delivered',
    })
  })

  it('does not refund a conversational fall-through (delivered value)', () => {
    expect(classifyRefund({ finalStatus: 'fell_through', creditsCharged: 12 })).toEqual({
      refund: false,
      reason: 'delivered',
    })
  })

  it('FULL-refunds a normal-cost OUR-failure (error)', () => {
    const d = classifyRefund({ finalStatus: 'error', creditsCharged: 30, costMicroUsd: 90_000 })
    expect(d).toEqual({ refund: true, kind: 'full', credits: 30, reason: 'error' })
  })

  it('full-refunds a charged "refused" turn', () => {
    const d = classifyRefund({ finalStatus: 'refused', creditsCharged: 25, costMicroUsd: 40_000 })
    expect(d).toEqual({ refund: true, kind: 'full', credits: 25, reason: 'refused' })
  })

  it('caps a full refund at PER_FAILURE_REFUND_CAP_CREDITS', () => {
    const d = classifyRefund({
      finalStatus: 'error',
      creditsCharged: PER_FAILURE_REFUND_CAP_CREDITS + 200,
      costMicroUsd: 100_000,
    })
    expect(d).toEqual({ refund: true, kind: 'full', credits: PER_FAILURE_REFUND_CAP_CREDITS, reason: 'error' })
  })

  it('COST-SPLITS a large/unusual high-cost failure (~50%)', () => {
    const charged = 80
    const d = classifyRefund({
      finalStatus: 'error',
      creditsCharged: charged,
      costMicroUsd: COST_SPLIT_THRESHOLD_MICRO_USD, // exactly at threshold → split
    })
    expect(d).toEqual({
      refund: true,
      kind: 'cost_split',
      credits: Math.ceil(charged * COST_SPLIT_REFUND_RATIO), // 40
      reason: 'cost_split',
    })
  })

  it('cost-split also respects the per-failure cap', () => {
    const d = classifyRefund({
      finalStatus: 'error',
      creditsCharged: (PER_FAILURE_REFUND_CAP_CREDITS + 100) * 2, // half exceeds the cap
      costMicroUsd: COST_SPLIT_THRESHOLD_MICRO_USD + 1,
    })
    expect(d.refund).toBe(true)
    if (d.refund) {
      expect(d.kind).toBe('cost_split')
      expect(d.credits).toBe(PER_FAILURE_REFUND_CAP_CREDITS)
    }
  })

  it('treats just-below-threshold cost as a full refund, not a split', () => {
    const d = classifyRefund({
      finalStatus: 'error',
      creditsCharged: 50,
      costMicroUsd: COST_SPLIT_THRESHOLD_MICRO_USD - 1,
    })
    expect(d).toEqual({ refund: true, kind: 'full', credits: 50, reason: 'error' })
  })
})
