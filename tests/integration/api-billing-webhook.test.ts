// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { setDbForTesting } from '@/lib/db'
import { stripeEvents, users } from '@/lib/db/schema'
import { makeTestDb } from '../factories/db'
import { getWallet } from '@/lib/billing/wallet'

/**
 * PR-13 — route-level + concurrent-delivery coverage for the Stripe webhook
 * endpoint (deferred from PR-10). The Stripe module is mocked so we drive
 * constructEvent's OUTPUT (a verified event, or a throw = bad signature) without a
 * real key; the grant logic (handleStripeEvent) + the DB are REAL. The key
 * contract pinned here: a FAILED grant still returns 200, so Stripe will NOT
 * retry — which is exactly why the in-process reconcile scheduler is load-bearing.
 */

const constructEventMock = vi.fn()
vi.mock('@/lib/billing/stripe', () => ({
  isStripeEnabled: () => true,
  getStripe: () => ({ webhooks: { constructEvent: constructEventMock } }),
}))

const { POST } = await import('@/app/api/billing/webhook/route')

type Db = ReturnType<typeof makeTestDb>

function eventJson(sessionOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        object: 'checkout.session',
        payment_status: 'paid',
        client_reference_id: 'u1',
        metadata: { userId: 'u1', packId: 'pack_20' },
        currency: 'usd',
        amount_subtotal: 2000,
        amount_total: 2160,
        total_details: { amount_discount: 0 },
        ...sessionOverrides,
      },
    },
  })
}

describe('POST /api/billing/webhook (PR-13 route-level)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    setDbForTesting(db)
    constructEventMock.mockReset()
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test')
  })
  afterEach(() => {
    setDbForTesting(undefined)
    vi.unstubAllEnvs()
  })

  const post = (body: string, headers: Record<string, string> = { 'stripe-signature': 'sig' }) =>
    POST(new Request('http://localhost:3000/api/billing/webhook', { method: 'POST', headers, body }))

  it('404 when the webhook is not configured (self-host: no signing secret)', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    expect((await post(eventJson())).status).toBe(404)
  })

  it('400 when the stripe-signature header is missing', async () => {
    expect((await post(eventJson(), {})).status).toBe(400)
  })

  it('400 when signature verification fails (constructEvent throws)', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('bad signature')
    })
    const res = await post(eventJson())
    expect(res.status).toBe(400)
    expect(getWallet('u1', db).balance).toBe(0)
  })

  it('200 + grants the pack credits on a verified paid session', async () => {
    constructEventMock.mockImplementation((raw: string) => JSON.parse(raw))
    const res = await post(eventJson())
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('processed')
    expect(getWallet('u1', db).balance).toBe(2200)
  })

  it('200 even when the grant FAILS — Stripe will NOT retry, so reconcile must heal it', async () => {
    constructEventMock.mockImplementation((raw: string) => JSON.parse(raw))
    const res = await post(eventJson({ metadata: { userId: 'u1', packId: 'nope' } }))
    expect(res.status).toBe(200) // absorbed, NOT a 5xx → no Stripe retry
    expect((await res.json()).status).toBe('failed')
    expect(getWallet('u1', db).balance).toBe(0) // not granted
    // Left in the inbox as 'failed' for the reconcile scheduler to retry.
    expect(db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_1')).get()?.status).toBe('failed')
  })

  it('a redelivered event credits at most once (idempotent inbox)', async () => {
    constructEventMock.mockImplementation((raw: string) => JSON.parse(raw))
    await post(eventJson())
    const res2 = await post(eventJson())
    expect(res2.status).toBe(200)
    expect((await res2.json()).status).toBe('duplicate')
    expect(getWallet('u1', db).balance).toBe(2200) // credited once, not twice
  })

  it('two DIFFERENT event ids for the SAME session credit once (grant dedups on session id)', async () => {
    constructEventMock.mockImplementation((raw: string) => JSON.parse(raw))
    // Simulate a checkout.session.completed + payment_intent double-delivery for one payment.
    await post(JSON.stringify({ ...JSON.parse(eventJson()), id: 'evt_a' }))
    await post(JSON.stringify({ ...JSON.parse(eventJson()), id: 'evt_b' }))
    expect(getWallet('u1', db).balance).toBe(2200) // session-id external_ref dedups
  })
})
