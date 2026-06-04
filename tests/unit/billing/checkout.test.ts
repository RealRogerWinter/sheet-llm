import { describe, expect, it } from 'vitest'
import { buildCheckoutSessionParams, checkPurchaseEligibility } from '@/lib/billing/checkout'
import { getPack } from '@/lib/billing/packs'

describe('checkPurchaseEligibility', () => {
  it('refuses an anonymous user', () => {
    const r = checkPurchaseEligibility({ authenticated: false, email: null, emailVerified: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('login_required')
      expect(r.status).toBe(401)
    }
  })

  it('refuses an authenticated account with no email on file', () => {
    const r = checkPurchaseEligibility({ authenticated: true, email: null, emailVerified: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('login_required')
  })

  it('refuses a claimed but UNVERIFIED account', () => {
    const r = checkPurchaseEligibility({ authenticated: true, email: 'a@b.com', emailVerified: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('verify_email')
      expect(r.status).toBe(403)
    }
  })

  it('allows a claimed, email-verified account', () => {
    expect(checkPurchaseEligibility({ authenticated: true, email: 'a@b.com', emailVerified: true })).toEqual({ ok: true })
  })
})

describe('buildCheckoutSessionParams', () => {
  const pack = getPack('pack_20')!
  const params = buildCheckoutSessionParams({
    pack,
    userId: 'u-1',
    email: 'a@b.com',
    successUrl: 'https://x/ok',
    cancelUrl: 'https://x/no',
  })

  it('charges the pack price in USD as a one-off payment', () => {
    expect(params.mode).toBe('payment')
    expect(params.line_items?.[0]?.price_data?.currency).toBe('usd')
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(2000)
  })

  it('embeds the granted credits + userId on metadata AND the PaymentIntent', () => {
    expect(params.metadata).toEqual({ userId: 'u-1', packId: 'pack_20', credits: '2200' })
    expect(params.payment_intent_data?.metadata).toEqual({ userId: 'u-1', packId: 'pack_20', credits: '2200' })
  })

  it('carries client_reference_id as the userId (webhook fallback mapping)', () => {
    expect(params.client_reference_id).toBe('u-1')
  })

  it('passes the success/cancel URLs and enables Stripe Tax', () => {
    expect(params.success_url).toBe('https://x/ok')
    expect(params.cancel_url).toBe('https://x/no')
    expect(params.automatic_tax).toEqual({ enabled: true })
  })
})
