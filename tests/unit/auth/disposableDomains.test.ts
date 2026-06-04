import { describe, expect, it } from 'vitest'
import { isDisposableEmail } from '@/lib/auth/disposableDomains'

describe('isDisposableEmail', () => {
  it('flags known disposable domains (case-insensitive)', () => {
    expect(isDisposableEmail('a@mailinator.com')).toBe(true)
    expect(isDisposableEmail('A@Mailinator.COM')).toBe(true)
    expect(isDisposableEmail('x@guerrillamail.com')).toBe(true)
    expect(isDisposableEmail('x@yopmail.fr')).toBe(true)
  })

  it('flags subdomains of a blocked registrable domain', () => {
    expect(isDisposableEmail('a@inbox.mailinator.com')).toBe(true)
    expect(isDisposableEmail('a@x.y.mailinator.com')).toBe(true)
  })

  it('allows normal providers and corporate domains', () => {
    expect(isDisposableEmail('a@gmail.com')).toBe(false)
    expect(isDisposableEmail('a@proton.me')).toBe(false)
    expect(isDisposableEmail('a@my-company.io')).toBe(false)
  })

  it('returns false on a malformed email (no @ or empty domain)', () => {
    expect(isDisposableEmail('not-an-email')).toBe(false)
    expect(isDisposableEmail('a@')).toBe(false)
  })
})
