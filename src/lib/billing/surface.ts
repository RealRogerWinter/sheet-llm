import { isStripeEnabled } from './stripe'
import { isPaidGenerationEnabled } from '@/lib/auth/account'

/**
 * Is the customer-facing BILLING SURFACE (wallet balance + activity + buy flow)
 * enabled for this instance? True when the user can BUY credits (Stripe
 * configured) OR SPEND them (paid generation on) — either flag lights up the
 * wallet; NEITHER hides it entirely so a self-hosted / BYOK install shows
 * nothing. The wallet/transactions read routes 404 on false, and the settings
 * Wallet section hides itself when its fetch 404s. Read fresh per request.
 */
export function isBillingSurfaceEnabled(): boolean {
  return isStripeEnabled() || isPaidGenerationEnabled()
}
