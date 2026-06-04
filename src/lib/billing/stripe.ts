import Stripe from 'stripe'

/**
 * Stripe client + feature gate (HOSTED billing; sheetllm.com only).
 *
 * The paid layer is INERT until a key is present: with no `STRIPE_SECRET_KEY`
 * set, `isStripeEnabled()` is false, every billing route 404s, and no client is
 * ever constructed — so a self-hosted / BYOK install never touches Stripe.
 * Presence of the secret key IS the on-switch ("add the keys to turn it on").
 *
 * DARK: this is the money-IN (purchase) side only; nothing spends credits yet
 * (the paywall is a later PR). A completed Checkout grants credits via the
 * webhook (next PR) — without it a payment takes money but grants nothing, so
 * the webhook MUST be deployed before any real key goes live.
 */

let cached: Stripe | undefined

/** True when Stripe is configured (a secret key is present). Read fresh. */
export function isStripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

/**
 * Lazy Stripe singleton. Throws if called without a key — callers MUST gate on
 * `isStripeEnabled()` first (the routes 404 when disabled). A newly-added key
 * is picked up on process restart (standard for env-based secrets).
 */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error('[billing] getStripe() called but STRIPE_SECRET_KEY is not set')
  }
  if (!cached) {
    // apiVersion intentionally omitted — pin to the SDK's bundled default so a
    // version bump is a single, reviewed dependency change rather than a magic
    // string drifting from the installed types.
    cached = new Stripe(key)
  }
  return cached
}

/** Test-only: drop the memoized client so a test can swap the env key. */
export function __resetStripeForTest(): void {
  cached = undefined
}
