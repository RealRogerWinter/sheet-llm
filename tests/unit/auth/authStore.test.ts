// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/lib/auth/authStore'

beforeEach(() => {
  useAuthStore.setState({
    status: 'loading',
    email: null,
    emailVerified: false,
    tier: 'free',
    csrfToken: null,
    oauthProviders: [],
    loginOpen: false,
  })
})

describe('authStore.setSession', () => {
  it('→ disabled when the accounts flag is off', () => {
    useAuthStore.getState().setSession({ enabled: false, authenticated: false })
    expect(useAuthStore.getState().status).toBe('disabled')
  })

  it('→ anon when enabled but not authenticated (carries csrf + providers)', () => {
    useAuthStore.getState().setSession({
      enabled: true,
      authenticated: false,
      csrfToken: 'tok',
      oauthProviders: ['google'],
    })
    const s = useAuthStore.getState()
    expect(s.status).toBe('anon')
    expect(s.csrfToken).toBe('tok')
    expect(s.oauthProviders).toEqual(['google'])
    expect(s.email).toBeNull()
  })

  it('→ authed with the profile fields', () => {
    useAuthStore.getState().setSession({
      enabled: true,
      authenticated: true,
      email: 'a@b.c',
      emailVerified: true,
      tier: 'pro',
      csrfToken: 't2',
    })
    const s = useAuthStore.getState()
    expect(s.status).toBe('authed')
    expect(s.email).toBe('a@b.c')
    expect(s.emailVerified).toBe(true)
    expect(s.tier).toBe('pro')
  })
})

describe('authStore modal flag', () => {
  it('openLogin / closeLogin toggle loginOpen', () => {
    useAuthStore.getState().openLogin()
    expect(useAuthStore.getState().loginOpen).toBe(true)
    useAuthStore.getState().closeLogin()
    expect(useAuthStore.getState().loginOpen).toBe(false)
  })
})
