import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getExistingRequestUser } from '@/lib/auth/session'
import { isSameOriginStrict, isJsonRequest } from '@/lib/auth/httpGuards'
import { getStripe, isStripeEnabled } from '@/lib/billing/stripe'
import { getPack } from '@/lib/billing/packs'
import { buildCheckoutSessionParams, checkPurchaseEligibility } from '@/lib/billing/checkout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({ packId: z.string().min(1).max(40) })

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

  const origin = new URL(request.url).origin
  const params = buildCheckoutSessionParams({
    pack,
    userId: user!.userId,
    email: account!.email!,
    successUrl: `${origin}/?checkout=success`,
    cancelUrl: `${origin}/?checkout=cancel`,
  })

  try {
    const checkout = await getStripe().checkout.sessions.create(params)
    if (!checkout.url) {
      return NextResponse.json({ code: 'upstream_error', error: 'Checkout session has no URL' }, { status: 502 })
    }
    return NextResponse.json({ url: checkout.url })
  } catch (e) {
    console.error('[billing] checkout session create failed', {
      userId: user!.userId,
      packId: pack.id,
      error: e instanceof Error ? e.message : String(e),
    })
    return NextResponse.json({ code: 'upstream_error', error: 'Could not start checkout. Please try again.' }, { status: 502 })
  }
}
