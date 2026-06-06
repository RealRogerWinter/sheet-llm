import type { Metadata } from 'next'
import { CREDIT_PACKS } from '@/lib/billing/packs'
import PricingContent, { type PricingPack } from './PricingContent'

// The display face (Fraunces) is now loaded globally in app/layout.tsx and
// exposed site-wide as --font-fraunces, so this page no longer loads its own
// copy — the scoped --font-display in Pricing.module.css resolves against the
// global variable, keeping the page byte-identical with one fewer font load.

// Unlike /pro and /signup (transient, noindex), this is a real marketing page —
// let it be indexed. It surfaces the credit-pack catalog and the Pro tier with
// clear prices even while billing is still dark (no checkout yet), so visitors
// and search engines can see exactly what's for sale.
export const metadata: Metadata = {
  title: 'Pricing — sheet-llm',
  description:
    'Buy credits to compose full-length sheet music with sheet-llm. Simple pay-as-you-go packs from $5, no subscription. See prices and how credits are used.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'sheet-llm Pricing — pay-as-you-go credits',
    description:
      'Pay-as-you-go credit packs from $5. No subscription. See exactly what each pack buys and how credits are spent on AI music generation.',
    type: 'website',
  },
}

// Project the locked pack catalog (src/lib/billing/packs.ts) into the plain,
// serializable shape the client component renders. Keeping packs.ts as the single
// source of truth means the displayed prices can never drift from what Stripe
// will actually charge once billing is switched on.
const PACKS: PricingPack[] = CREDIT_PACKS.map((p) => ({
  id: p.id,
  label: p.label,
  priceUsdCents: p.priceUsdCents,
  baseCredits: p.baseCredits,
  bonusCredits: p.bonusCredits,
  totalCredits: p.totalCredits,
}))

export default function PricingPage() {
  return <PricingContent packs={PACKS} />
}
