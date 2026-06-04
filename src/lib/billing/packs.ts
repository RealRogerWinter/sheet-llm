/**
 * Credit-pack catalog (HOSTED billing; sheetllm.com only). 1 credit = 1¢ of
 * customer value, so a $5 pack is 500 base credits; larger packs add an
 * escalating BONUS (a volume discount that also lifts average order value). The
 * 2.5× markup lives in the SPEND rate (credits charged per generation), NOT
 * here — purchase is a flat $1 = 100 credits plus the bonus.
 *
 * Prices are integer cents and credits are integers — money is NEVER a float.
 * Operator-tunable; re-derive bonuses from measured margin post-launch.
 */
export interface CreditPack {
  id: string
  label: string
  /** Amount charged, integer cents (the Stripe `unit_amount`). */
  priceUsdCents: number
  /** Base credits = priceUsdCents (1 credit = 1 cent of value). */
  baseCredits: number
  /** Volume bonus granted on top of the base. */
  bonusCredits: number
  /** baseCredits + bonusCredits — the total granted on a settled payment. */
  totalCredits: number
}

function pack(id: string, label: string, priceUsdCents: number, bonusCredits: number): CreditPack {
  const baseCredits = priceUsdCents // 1 credit = 1 cent
  return { id, label, priceUsdCents, baseCredits, bonusCredits, totalCredits: baseCredits + bonusCredits }
}

/** The four packs (locked 2026-06-04): $5 / $10 / $20 / $50, $5 minimum,
 *  escalating 0 / 5 / 10 / 15% bonus. */
export const CREDIT_PACKS: readonly CreditPack[] = [
  pack('pack_5', 'Starter', 500, 0), //   $5  → 500   credits
  pack('pack_10', 'Plus', 1000, 50), //  $10  → 1,050 credits (+5%)
  pack('pack_20', 'Pro', 2000, 200), //  $20  → 2,200 credits (+10%)
  pack('pack_50', 'Studio', 5000, 750), // $50 → 5,750 credits (+15%)
] as const

export function getPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id)
}
