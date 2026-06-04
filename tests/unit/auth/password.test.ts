// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  ARGON2_PARAMS,
} from '@/lib/auth/password'

describe('password hashing (argon2id)', () => {
  it('hashes to an argon2id v19 PHC string and verifies the correct password', async () => {
    const h = await hashPassword('correct horse battery staple')
    // Asserts the algorithm/version/costs actually used — guards against a
    // library-default change silently weakening us.
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true)
  })

  it('rejects a wrong or empty password', async () => {
    const h = await hashPassword('s3cret-password')
    expect(await verifyPassword(h, 's3cret-passwordX')).toBe(false)
    expect(await verifyPassword(h, '')).toBe(false)
  })

  it('produces a distinct hash each call (random salt), both verifying', async () => {
    const a = await hashPassword('same-input')
    const b = await hashPassword('same-input')
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'same-input')).toBe(true)
    expect(await verifyPassword(b, 'same-input')).toBe(true)
  })

  it('verifyPassword never throws on a malformed / foreign hash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false)
    expect(await verifyPassword('', 'x')).toBe(false)
    // a bcrypt-style hash is foreign to argon2 → non-match, no throw
    expect(await verifyPassword('$2b$10$abcdefghijklmnopqrstuv', 'x')).toBe(false)
  })

  it('needsRehash flags weaker/older/foreign hashes, not current ones', async () => {
    expect(needsRehash(await hashPassword('pw'))).toBe(false)
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true) // weak memory
    expect(needsRehash('$argon2id$v=16$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true) // old version
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true) // foreign algo
    expect(needsRehash('nope')).toBe(true) // garbage
  })

  it('ARGON2_PARAMS meets the OWASP argon2id floor', () => {
    expect(ARGON2_PARAMS.memoryCost).toBeGreaterThanOrEqual(19_456)
    expect(ARGON2_PARAMS.timeCost).toBeGreaterThanOrEqual(2)
  })
})
