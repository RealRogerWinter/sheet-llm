import type Stripe from 'stripe'
import type { CreditPack } from './packs'

/**
 * Server-side purchase ELIGIBILITY gate (red-team must-fix #6). Only a CLAIMED,
 * EMAIL-VERIFIED account may buy credits: a purchase ties real money to an
 * identity for fraud / chargeback handling, and an anonymous bearer-cookie user
 * is GC-able and trivially farmable. Anonymous / unclaimed / unverified callers
 * are refused with a clean, actionable error. Enforced server-side at
 * create-checkout-session — never trusted from the client.
 */
export type PurchaseEligibility =
  | { ok: true }
  | { ok: false; code: 'login_required' | 'verify_email'; status: number; message: string }

export function checkPurchaseEligibility(user: {
  authenticated: boolean
  email: string | null
  emailVerified: boolean
}): PurchaseEligibility {
  if (!user.authenticated || !user.email) {
    return {
      ok: false,
      code: 'login_required',
      status: 401,
      message: 'Log in to your account to purchase credits.',
    }
  }
  if (!user.emailVerified) {
    return {
      ok: false,
      code: 'verify_email',
      status: 403,
      message: 'Verify your email address before purchasing credits.',
    }
  }
  return { ok: true }
}

/**
 * Build the Stripe Checkout session params for a credit pack. Pure (no network)
 * so the money-bearing fields are unit-testable in isolation: the charged
 * amount, the credit count embedded for the webhook to grant, Stripe Tax, and
 * the userId carried on BOTH `metadata` and `client_reference_id` (so the
 * webhook can still map the payment to a user if metadata is ever stripped).
 *
 * `mode: 'payment'` = a one-off charge (prepaid credits, no subscription).
 */
export function buildCheckoutSessionParams(input: {
  pack: CreditPack
  userId: string
  email: string
  successUrl: string
  cancelUrl: string
}): Stripe.Checkout.SessionCreateParams {
  const { pack, userId, email, successUrl, cancelUrl } = input
  const meta = { userId, packId: pack.id, credits: String(pack.totalCredits) }
  return {
    mode: 'payment',
    customer_email: email,
    client_reference_id: userId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Global sales → let Stripe Tax compute jurisdiction; collect the address it
    // needs. tax_behavior 'exclusive' adds tax on top of the listed price.
    automatic_tax: { enabled: true },
    billing_address_collection: 'auto',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pack.priceUsdCents,
          tax_behavior: 'exclusive',
          product_data: {
            name: `${pack.totalCredits.toLocaleString('en-US')} credits`,
            description: `${pack.label} pack — ${pack.totalCredits.toLocaleString('en-US')} sheetllm.com credits`,
          },
        },
      },
    ],
    metadata: meta,
    // Mirror onto the PaymentIntent so a webhook keyed off either object can map it.
    payment_intent_data: { metadata: meta },
  }
}
