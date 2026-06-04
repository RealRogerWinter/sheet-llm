import { NextResponse } from 'next/server'
import { isStripeEnabled } from '@/lib/billing/stripe'
import { CREDIT_PACKS } from '@/lib/billing/packs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/billing/packs — the credit-pack catalog for the purchase UI.
 * 404s when Stripe is not configured, so the whole billing surface stays dark
 * on a self-hosted / BYOK install. Read-only, no secrets.
 */
export async function GET() {
  if (!isStripeEnabled()) {
    return NextResponse.json({ code: 'not_found', error: 'Billing is not enabled' }, { status: 404 })
  }
  return NextResponse.json({
    packs: CREDIT_PACKS.map((p) => ({
      id: p.id,
      label: p.label,
      priceUsdCents: p.priceUsdCents,
      credits: p.totalCredits,
      bonusCredits: p.bonusCredits,
    })),
  })
}
