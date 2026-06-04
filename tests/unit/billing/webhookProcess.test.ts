// @vitest-environment node
import type Stripe from 'stripe'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { stripeEvents, users } from '@/lib/db/schema'
import { getWallet } from '@/lib/billing/wallet'
import { handleStripeEvent, processStripeEvent, reconcileStripeEvents } from '@/lib/billing/webhookProcess'

type Db = ReturnType<typeof makeTestDb>

function makeUser(db: Db, id: string): void {
  db.insert(users).values({ id, createdAt: 0, lastSeenAt: 0 }).run()
}

/** Build a `checkout.session.completed` event; pack_20 = $20 → 2,200 credits. */
function makeEvent(o: {
  eventId?: string
  sessionId?: string
  userId?: string | null
  packId?: string
  metaCredits?: string
  amountSubtotal?: number | null
  amountTotal?: number
  currency?: string
  paymentStatus?: string
  type?: string
}): Stripe.Event {
  const userId = o.userId === undefined ? 'u1' : o.userId
  return {
    id: o.eventId ?? 'evt_1',
    type: o.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: o.sessionId ?? 'cs_1',
        object: 'checkout.session',
        payment_status: o.paymentStatus ?? 'paid',
        client_reference_id: userId,
        metadata: { ...(userId ? { userId } : {}), packId: o.packId ?? 'pack_20', credits: o.metaCredits ?? '2200' },
        currency: o.currency ?? 'usd',
        amount_subtotal: o.amountSubtotal === undefined ? 2000 : o.amountSubtotal,
        amount_total: o.amountTotal ?? 2160,
      },
    },
  } as unknown as Stripe.Event
}

describe('processStripeEvent', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    makeUser(db, 'u1')
  })

  it('grants the pack credits on a paid session', () => {
    const r = processStripeEvent(makeEvent({}), db)
    expect(r).toEqual({ status: 'processed', userId: 'u1', creditsGranted: 2200 })
    expect(getWallet('u1', db).balance).toBe(2200)
  })

  it('IGNORES metadata.credits — credits are re-derived from the pack', () => {
    // Attacker inflates metadata.credits; the grant must still be the pack total.
    const r = processStripeEvent(makeEvent({ metaCredits: '999999' }), db)
    expect(r.status).toBe('processed')
    expect(getWallet('u1', db).balance).toBe(2200) // not 999999
  })

  it('REFUSES when the amount paid does not match the pack price (claim a bigger pack)', () => {
    // Paid $20 (amount_subtotal 2000) but claims pack_50 ($50). Must not grant.
    const r = processStripeEvent(makeEvent({ packId: 'pack_50', amountSubtotal: 2000 }), db)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.reason).toMatch(/amount_mismatch/)
    expect(getWallet('u1', db).balance).toBe(0)
  })

  it('refuses an unknown pack, a non-USD currency, and a missing user ref', () => {
    expect(processStripeEvent(makeEvent({ packId: 'nope' }), db).status).toBe('failed')
    expect(processStripeEvent(makeEvent({ currency: 'eur' }), db).status).toBe('failed')
    expect(processStripeEvent(makeEvent({ userId: null }), db).status).toBe('failed')
    expect(getWallet('u1', db).balance).toBe(0)
  })

  it('ignores an unpaid session and an unhandled event type', () => {
    expect(processStripeEvent(makeEvent({ paymentStatus: 'unpaid' }), db).status).toBe('ignored')
    expect(processStripeEvent(makeEvent({ type: 'payment_intent.created' }), db).status).toBe('ignored')
    expect(getWallet('u1', db).balance).toBe(0)
  })

  it('refuses a session with a null subtotal (can not verify the amount)', () => {
    const r = processStripeEvent(makeEvent({ amountSubtotal: null }), db)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.reason).toMatch(/amount_mismatch/)
    expect(getWallet('u1', db).balance).toBe(0)
  })
})

describe('handleStripeEvent (inbox + idempotency)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    makeUser(db, 'u1')
  })

  it('records the event to the inbox and grants once', () => {
    const out = handleStripeEvent(makeEvent({}), db, 100)
    expect(out.status).toBe('processed')
    const row = db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_1')).get()
    expect(row?.status).toBe('processed')
    expect(row?.creditsGranted).toBe(2200)
    expect(row?.userId).toBe('u1')
    expect(getWallet('u1', db).balance).toBe(2200)
  })

  it('is idempotent on a redelivered event id (second is a duplicate, credited once)', () => {
    handleStripeEvent(makeEvent({ eventId: 'evt_1' }), db, 100)
    const second = handleStripeEvent(makeEvent({ eventId: 'evt_1' }), db, 101)
    expect(second.status).toBe('duplicate')
    expect(getWallet('u1', db).balance).toBe(2200) // once
  })

  it('credits once across DIFFERENT event ids for the SAME session (grant dedups on session id)', () => {
    handleStripeEvent(makeEvent({ eventId: 'evt_a', sessionId: 'cs_X' }), db, 100)
    handleStripeEvent(makeEvent({ eventId: 'evt_b', sessionId: 'cs_X' }), db, 101)
    expect(getWallet('u1', db).balance).toBe(2200) // session-id external_ref dedups
  })
})

describe('reconcileStripeEvents (auto-heal)', () => {
  it('re-processes an inbox row stuck at received and grants it', () => {
    const db = makeTestDb()
    makeUser(db, 'u1')
    // Simulate a crash AFTER inbox insert, BEFORE the grant: a 'received' row.
    db.insert(stripeEvents)
      .values({ eventId: 'evt_1', type: 'checkout.session.completed', status: 'received', payload: JSON.stringify(makeEvent({})), receivedAt: 0 })
      .run()
    expect(getWallet('u1', db).balance).toBe(0)
    const res = reconcileStripeEvents(db, { now: 200 })
    expect(res.healed).toBe(1)
    expect(getWallet('u1', db).balance).toBe(2200)
    expect(db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_1')).get()?.status).toBe('processed')
  })
})
