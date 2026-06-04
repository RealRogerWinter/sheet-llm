// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { __resetStripeForTest, getStripe, isStripeEnabled } from '@/lib/billing/stripe'

const ORIG = process.env.STRIPE_SECRET_KEY

afterEach(() => {
  if (ORIG === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = ORIG
  __resetStripeForTest()
})

describe('stripe gate', () => {
  it('isStripeEnabled tracks the secret-key presence', () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(isStripeEnabled()).toBe(false)
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    expect(isStripeEnabled()).toBe(true)
  })

  it('getStripe throws when no key is configured (callers must gate first)', () => {
    delete process.env.STRIPE_SECRET_KEY
    __resetStripeForTest()
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY/)
  })

  it('getStripe returns a memoized client when configured', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    __resetStripeForTest()
    const a = getStripe()
    const b = getStripe()
    expect(a).toBe(b)
  })
})
