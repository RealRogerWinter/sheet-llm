import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getStripe, isStripeEnabled } from '@/lib/billing/stripe'
import { handleStripeEvent } from '@/lib/billing/webhookProcess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Stripe events are small; reject an oversized body before reading it (the
// signature check would fail anyway, but don't buffer megabytes first).
const MAX_BODY_BYTES = 1024 * 1024

/** The webhook needs BOTH the secret key (to construct the client) and the
 *  signing secret (to verify deliveries). Absent either, the endpoint is dark. */
function isWebhookConfigured(): boolean {
  return isStripeEnabled() && !!process.env.STRIPE_WEBHOOK_SECRET
}

/**
 * POST /api/billing/webhook — Stripe delivery endpoint. Verifies the signature
 * over the RAW body, then records + processes the event (grant is idempotent).
 * 404 when unconfigured (self-hosted); 400 on a bad/absent signature; 200 once
 * the event is safely recorded; 500 only on an unexpected fault so Stripe retries.
 */
export async function POST(request: Request) {
  if (!isWebhookConfigured()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const sig = request.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  // RAW body is REQUIRED — constructEvent recomputes the HMAC over these exact
  // bytes. Parsing to JSON first would break verification.
  const raw = await request.text()
  // The content-length pre-check is spoofable; re-check the ACTUAL bytes so a
  // missing/forged header can't push an unbounded payload into constructEvent on
  // this unauthenticated endpoint. (The platform/proxy body limit is the outer backstop.)
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  let event
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET as string)
  } catch (e) {
    console.warn('[billing] webhook signature verification failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    const outcome = handleStripeEvent(event, getDb())
    return NextResponse.json({ received: true, status: outcome.status })
  } catch (e) {
    // The event is signature-verified but processing threw before/around the
    // inbox write (e.g. DB unavailable). 500 → Stripe redelivers; if the inbox
    // row landed, the reconciliation reaper also heals it. Never leak internals.
    console.error('[billing] webhook handling failed', {
      eventId: event.id,
      type: event.type,
      error: e instanceof Error ? e.message : String(e),
    })
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
