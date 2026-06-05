// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { sectionalAbortReason } from '@/app/api/chat/route'
import { costToCredits, MARKUP_GENERATE } from '@/lib/billing/valueTier'

/**
 * PR-7b-2c — the pure abort decision for the streamed sectional pump. Cost-abort
 * (paid path) takes precedence over the wall-clock; a null metered cost counts as
 * 0 credits; off the paid path (budgetCredits undefined) only the wall-clock can
 * fire (and only when enforced).
 */

const MARGIN = 66 // sectionAbortMarginCredits(8000)
const BUDGET = 491 // worst-case floor hold
const THRESHOLD_CREDITS = BUDGET - MARGIN // 425 → abort when meteredCredits >= this
// Smallest µUSD that costs-plus to exactly THRESHOLD_CREDITS credits.
const AT_THRESHOLD_MICRO = (THRESHOLD_CREDITS * 10_000) / MARKUP_GENERATE // 1_700_000
const BELOW_THRESHOLD_MICRO = AT_THRESHOLD_MICRO - 40_000

const NO_WALL = { enforceWallClock: false, elapsedMs: 0, deadlineMs: 270_000 }

describe('sectionalAbortReason — cost (budget) trigger', () => {
  it('fires "budget" when metered cost-plus credits reach budget − margin', () => {
    expect(costToCredits(AT_THRESHOLD_MICRO, MARKUP_GENERATE)).toBe(THRESHOLD_CREDITS) // sanity
    expect(
      sectionalAbortReason({
        budgetCredits: BUDGET,
        meteredMicroUsd: AT_THRESHOLD_MICRO,
        abortMargin: MARGIN,
        ...NO_WALL,
      }),
    ).toBe('budget')
  })

  it('does NOT fire just below the threshold', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: BUDGET,
        meteredMicroUsd: BELOW_THRESHOLD_MICRO,
        abortMargin: MARGIN,
        ...NO_WALL,
      }),
    ).toBeUndefined()
  })

  it('treats a null metered cost as 0 credits (never spuriously aborts on budget)', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: BUDGET,
        meteredMicroUsd: null,
        abortMargin: MARGIN,
        ...NO_WALL,
      }),
    ).toBeUndefined()
  })

  it('never fires "budget" off the paid path (budgetCredits undefined)', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: undefined,
        meteredMicroUsd: 999_999_999,
        abortMargin: MARGIN,
        ...NO_WALL,
      }),
    ).toBeUndefined()
  })
})

describe('sectionalAbortReason — wall-clock trigger', () => {
  it('fires "wall_clock" once elapsed reaches the deadline (enforced)', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: undefined,
        meteredMicroUsd: 0,
        abortMargin: MARGIN,
        enforceWallClock: true,
        elapsedMs: 270_000,
        deadlineMs: 270_000,
      }),
    ).toBe('wall_clock')
  })

  it('does not fire before the deadline', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: undefined,
        meteredMicroUsd: 0,
        abortMargin: MARGIN,
        enforceWallClock: true,
        elapsedMs: 269_999,
        deadlineMs: 270_000,
      }),
    ).toBeUndefined()
  })

  it('never fires when the wall-clock is not enforced (pure-dark path)', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: undefined,
        meteredMicroUsd: 0,
        abortMargin: MARGIN,
        enforceWallClock: false,
        elapsedMs: 10_000_000,
        deadlineMs: 270_000,
      }),
    ).toBeUndefined()
  })
})

describe('sectionalAbortReason — precedence', () => {
  it('cost (budget) wins when both the budget and the wall-clock are exceeded', () => {
    expect(
      sectionalAbortReason({
        budgetCredits: BUDGET,
        meteredMicroUsd: AT_THRESHOLD_MICRO,
        abortMargin: MARGIN,
        enforceWallClock: true,
        elapsedMs: 300_000,
        deadlineMs: 270_000,
      }),
    ).toBe('budget')
  })
})
