// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.stubEnv(
    'RECOVERY_SECRET',
    'recovery-test-secret-distinct-from-session-32+bytes-x',
  )
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('signRecoveryToken / verifyRecoveryToken', () => {
  it('round-trips a freshly signed token and returns the same sub + nonce', async () => {
    const { signRecoveryToken, verifyRecoveryToken } = await import(
      '@/lib/auth/recovery'
    )
    const { token, nonce } = await signRecoveryToken('user-abc')
    expect(token.split('.').length).toBe(3) // JWT shape
    expect(nonce.length).toBeGreaterThanOrEqual(20)

    const result = await verifyRecoveryToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sub).toBe('user-abc')
      expect(result.nonce).toBe(nonce)
    }
  })

  it('rejects a garbage string as malformed', async () => {
    const { verifyRecoveryToken } = await import('@/lib/auth/recovery')
    const result = await verifyRecoveryToken('not-a-jwt')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('bad_signature')
    }
  })

  it('rejects a token signed with the WRONG secret as bad_signature', async () => {
    const { signRecoveryToken } = await import('@/lib/auth/recovery')
    const { token } = await signRecoveryToken('user-x')
    // Rotate the secret out from under verification.
    vi.stubEnv(
      'RECOVERY_SECRET',
      'a-completely-different-recovery-secret-32-bytes-x',
    )
    vi.resetModules()
    const { verifyRecoveryToken } = await import('@/lib/auth/recovery')
    const result = await verifyRecoveryToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('bad_signature')
    }
  })

  it('rejects an expired token as expired', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(
      'recovery-test-secret-distinct-from-session-32+bytes-x',
    )
    const token = await new SignJWT({ nonce: 'n1' })
      .setProtectedHeader({ alg: 'HS256', kid: 'r1' })
      .setSubject('user-y')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret)
    const { verifyRecoveryToken } = await import('@/lib/auth/recovery')
    const result = await verifyRecoveryToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('expired')
    }
  })

  it('rejects a token whose payload is missing nonce as malformed', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(
      'recovery-test-secret-distinct-from-session-32+bytes-x',
    )
    const token = await new SignJWT({}) // no nonce
      .setProtectedHeader({ alg: 'HS256', kid: 'r1' })
      .setSubject('user-z')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret)
    const { verifyRecoveryToken } = await import('@/lib/auth/recovery')
    const result = await verifyRecoveryToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('malformed')
    }
  })

  it('throws on missing RECOVERY_SECRET', async () => {
    vi.stubEnv('RECOVERY_SECRET', '')
    vi.resetModules()
    const { signRecoveryToken } = await import('@/lib/auth/recovery')
    await expect(signRecoveryToken('user-x')).rejects.toThrow(/RECOVERY_SECRET/)
  })

  it('throws on RECOVERY_SECRET shorter than 32 bytes', async () => {
    vi.stubEnv('RECOVERY_SECRET', 'too-short')
    vi.resetModules()
    const { signRecoveryToken } = await import('@/lib/auth/recovery')
    await expect(signRecoveryToken('user-x')).rejects.toThrow(/RECOVERY_SECRET/)
  })

  it('emits a distinct nonce per call (random)', async () => {
    const { signRecoveryToken } = await import('@/lib/auth/recovery')
    const a = await signRecoveryToken('user-x')
    const b = await signRecoveryToken('user-x')
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.token).not.toBe(b.token)
  })
})
