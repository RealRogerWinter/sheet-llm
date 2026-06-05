import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getExistingRequestUser } from '@/lib/auth/session'
import { isSameOriginStrict, isJsonRequest } from '@/lib/auth/httpGuards'
import { resolveAppBaseUrl } from '@/lib/auth/email'
import { getStripe, isStripeEnabled } from '@/lib/billing/stripe'
import { getPack } from '@/lib/billing/packs'
import { buildCheckoutSessionParams, checkPurchaseEligibility } from '@/lib/billing/checkout'
import { checkCheckoutRate, extractClientIp } from '@/lib/billing/checkoutRateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({ packId: z.string().min(1).max(40) })
const MAX_BODY_BYTES = 4 * 1024 // the body is just {packId}; reject anything large outright

/**
 * POST /api/billing/checkout — start a Stripe Checkout session for a credit pack.
 *
 * Guards, in order: strict same-origin + JSON-only (cross-site form CSRF can do
 * neither) → feature gate (404 when Stripe is off) → claimed + email-VERIFIED
 * account (anonymous bearer users can't buy; red-team #6). The userId rides on
 * the session's metadata AND client_reference_id so the webhook (next PR) can
 * grant credits idempotently. Returns the hosted Checkout URL.
 */
export async function POST(request: Request) {
  if (!isSameOriginStrict(request)) {
    return NextResponse.json({ code: 'forbidden', error: 'Cross-origin requests are not allowed' }, { status: 403 })
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ code: 'invalid_request', error: 'Expected application/json' }, { status: 415 })
  }
  if (!isStripeEnabled()) {
    return NextResponse.json({ code: 'not_found', error: 'Billing is not enabled' }, { status: 404 })
  }
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'invalid_request', error: 'Request body too large' }, { status: 413 })
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch {
    return NextResponse.json({ code: 'invalid_request', error: 'Invalid request body' }, { status: 400 })
  }

  const pack = getPack(body.packId)
  if (!pack) {
    return NextResponse.json({ code: 'invalid_request', error: 'Unknown pack' }, { status: 400 })
  }

  // Read-only identity (never mint a phantom user on a purchase attempt).
  const user = await getExistingRequestUser()
  const account = user
    ? await getDb()
        .select({ email: users.email, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, user.userId))
        .get()
    : undefined
  const eligibility = checkPurchaseEligibility({
    authenticated: user?.authenticated ?? false,
    email: account?.email ?? null,
    emailVerified: account?.emailVerified === 1,
  })
  if (!eligibility.ok) {
    return NextResponse.json({ code: eligibility.code, error: eligibility.message }, { status: eligibility.status })
  }

  // Throttle checkout-session creation per claimed user + per IP — the cheap
  // front half of card-testing is opening sessions in a loop. Checked AFTER
  // eligibility so only real account holders consume budget; one soft layer
  // beneath Stripe Radar + 3DS (operator launch config).
  const rate = checkCheckoutRate(user!.userId, extractClientIp(request))
  if (!rate.ok) {
    return NextResponse.json(
      { code: 'rate_limited', error: 'Too many checkout attempts — please wait a moment and try again.' },
      { status: 429, ...(rate.retryAfterSec ? { headers: { 'Retry-After': String(rate.retryAfterSec) } } : {}) },
    )
  }

  // Prefer APP_BASE_URL behind a proxy (request.url is the internal bind host);
  // a spoofed Host must not steer Stripe's post-checkout redirect off-origin.
  const origin = resolveAppBaseUrl(request)
  const params = buildCheckoutSessionParams({
    pack,
    userId: user!.userId,
    email: account!.email!,
    // Return to the wallet (settings) the buyer started from — WalletSettings
    // surfaces the result and re-pulls the balance. Same-origin via resolveAppBaseUrl.
    successUrl: `${origin}/settings?checkout=success`,
    cancelUrl: `${origin}/settings?checkout=cancel`,
    ...(process.env.SL_STRIPE_TAX_CODE ? { taxCode: process.env.SL_STRIPE_TAX_CODE } : {}),
  })

  try {
    const checkout = await getStripe().checkout.sessions.create(params)
    if (!checkout.url) {
      return NextResponse.json({ code: 'upstream_error', error: 'Checkout session has no URL' }, { status: 502 })
    }
    return NextResponse.json({ url: checkout.url })
  } catch (e) {
    // Surface the Stripe error code/requestId so an account-config failure (e.g.
    // Stripe Tax not enabled) is diagnosable rather than a blind 502.
    const se = e as { code?: string; type?: string; requestId?: string }
    console.error('[billing] checkout session create failed', {
      userId: user!.userId,
      packId: pack.id,
      error: e instanceof Error ? e.message : String(e),
      stripeCode: se.code,
      stripeType: se.type,
      stripeRequestId: se.requestId,
    })
    return NextResponse.json({ code: 'upstream_error', error: 'Could not start checkout. Please try again.' }, { status: 502 })
  }
}
