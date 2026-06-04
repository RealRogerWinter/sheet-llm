// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { authMessage, errorMessageFromResponse } from '@/lib/auth/authMessages'

describe('authMessage', () => {
  it('maps known codes to friendly copy', () => {
    expect(authMessage('invalid_credentials')).toMatch(/incorrect/i)
    expect(authMessage('rate_limited')).toMatch(/too many/i)
    expect(authMessage('email_taken')).toMatch(/already exists/i)
    expect(authMessage('email_taken_unverified')).toMatch(/reset your password/i)
  })

  it('falls back for unknown / empty codes (never shows the raw code)', () => {
    expect(authMessage('totally_unknown_code')).toMatch(/something went wrong/i)
    expect(authMessage(null)).toMatch(/something went wrong/i)
    expect(authMessage(undefined, 'custom fallback')).toBe('custom fallback')
  })
})

describe('errorMessageFromResponse', () => {
  it('maps a { code } JSON body', async () => {
    const res = new Response(JSON.stringify({ code: 'invalid_credentials' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    expect(await errorMessageFromResponse(res)).toMatch(/incorrect/i)
  })

  it('maps a 429 with no parseable code to rate-limited', async () => {
    expect(await errorMessageFromResponse(new Response('nope', { status: 429 }))).toMatch(/too many/i)
  })

  it('uses the generic fallback for an unparseable non-429 body', async () => {
    expect(await errorMessageFromResponse(new Response('boom', { status: 500 }))).toMatch(
      /something went wrong/i,
    )
  })
})
