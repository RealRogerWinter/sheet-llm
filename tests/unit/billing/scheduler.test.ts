// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDbForTesting } from '@/lib/db'
import { stripeEvents, users } from '@/lib/db/schema'
import { makeTestDb } from '../../factories/db'
import { creditWallet, getWallet, placeHold } from '@/lib/billing/wallet'
import {
  __stopBillingSchedulerForTesting,
  runBillingJanitorsOnce,
  startBillingScheduler,
} from '@/lib/billing/scheduler'

type Db = ReturnType<typeof makeTestDb>

// A 'received' inbox row whose grant never landed (a dropped/transiently-failed
// webhook). pack_20 → $20 / 2,200 credits. reconcileStripeEvents must heal it.
function makeStuckEvent(db: Db): void {
  db.insert(stripeEvents)
    .values({
      eventId: 'evt_stuck',
      type: 'checkout.session.completed',
      status: 'received',
      payload: JSON.stringify({
        id: 'evt_stuck',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_stuck',
            object: 'checkout.session',
            payment_status: 'paid',
            client_reference_id: 'u1',
            metadata: { userId: 'u1', packId: 'pack_20' },
            currency: 'usd',
            amount_subtotal: 2000,
            amount_total: 2160,
            total_details: { amount_discount: 0 },
          },
        },
      }),
      receivedAt: 0,
    })
    .run()
}

describe('runBillingJanitorsOnce (PR-13 per-subsystem gating)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    setDbForTesting(db)
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    __stopBillingSchedulerForTesting()
    setDbForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it('does NOTHING when neither billing subsystem is enabled (self-host)', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'test' }, db)
    placeHold({ userId: 'u1', requestId: 'r', idempotencyKey: 'k', credits: 30, ttlSec: -1 }, db)
    makeStuckEvent(db)
    const report = runBillingJanitorsOnce()
    expect(report).toEqual({ holdsReleased: 0, reconcile: null, eventsPruned: 0, checkoutBucketsEvicted: 0 })
    expect(getWallet('u1', db).held).toBe(30) // the expired hold was left untouched
    expect(getWallet('u1', db).balance).toBe(100) // the stuck event was NOT granted
  })

  it('reaps expired holds when SL_PAID_GENERATION is on (Stripe still off)', () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'test' }, db)
    placeHold({ userId: 'u1', requestId: 'r', idempotencyKey: 'k', credits: 30, ttlSec: -1 }, db)
    const report = runBillingJanitorsOnce()
    expect(report.holdsReleased).toBe(1)
    expect(getWallet('u1', db)).toEqual({ balance: 100, held: 0, available: 100 })
    expect(report.reconcile).toBeNull()
  })

  it('reconciles a dropped Stripe webhook when STRIPE_SECRET_KEY is set (paid flag off)', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x')
    makeStuckEvent(db)
    expect(getWallet('u1', db).balance).toBe(0)
    const report = runBillingJanitorsOnce()
    expect(report.reconcile?.healed).toBe(1)
    expect(getWallet('u1', db).balance).toBe(2200) // paid-but-not-granted self-healed
    expect(report.holdsReleased).toBe(0)
  })
})

describe('startBillingScheduler (PR-13 boot sweep + interval)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    setDbForTesting(db)
    vi.unstubAllEnvs()
    __stopBillingSchedulerForTesting()
  })
  afterEach(() => {
    __stopBillingSchedulerForTesting()
    setDbForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it('starts NO timer and runs no boot sweep when both subsystems are off', () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'test' }, db)
    placeHold({ userId: 'u1', requestId: 'r', idempotencyKey: 'k', credits: 30, ttlSec: -1 }, db)
    startBillingScheduler()
    expect(globalThis.__sheetllm_billing_scheduler).toBeUndefined()
    expect(getWallet('u1', db).held).toBe(30) // no boot sweep ran
  })

  it('runs a boot sweep immediately + starts one interval, idempotently', () => {
    vi.stubEnv('SL_PAID_GENERATION', '1')
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'test' }, db)
    placeHold({ userId: 'u1', requestId: 'r', idempotencyKey: 'k', credits: 30, ttlSec: -1 }, db)

    startBillingScheduler(60_000)
    expect(getWallet('u1', db).held).toBe(0) // boot sweep released the expired hold synchronously
    const handle = globalThis.__sheetllm_billing_scheduler
    expect(handle).toBeDefined()

    startBillingScheduler(60_000) // idempotent — keeps the same timer, no second sweep
    expect(globalThis.__sheetllm_billing_scheduler).toBe(handle)

    __stopBillingSchedulerForTesting()
    expect(globalThis.__sheetllm_billing_scheduler).toBeUndefined()
  })
})
