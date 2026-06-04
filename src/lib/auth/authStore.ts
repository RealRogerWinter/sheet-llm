'use client'

import { create } from 'zustand'

/**
 * Client auth state — the source of truth for the nav + pro-gating UI. Hydrated
 * from GET /api/auth/session (never trusted from a client copy) by `useAuthSync`.
 * `status` starts 'loading' so SSR + first paint render a stable placeholder
 * (the ThemeToggle deferred-read pattern); a brief logged-out flash on authed
 * loads is accepted for v1. 'disabled' hides the auth UI entirely when the
 * SL_ACCOUNTS_ENABLED flag is off.
 */
export type AuthStatus = 'loading' | 'disabled' | 'anon' | 'authed'

export interface SessionPayload {
  enabled: boolean
  authenticated: boolean
  email?: string | null
  emailVerified?: boolean
  tier?: string
  csrfToken?: string
  /** OAuth providers with credentials configured (for the sign-in buttons). */
  oauthProviders?: string[]
}

interface AuthState {
  status: AuthStatus
  email: string | null
  emailVerified: boolean
  tier: string
  /** Double-submit CSRF token for the next auth POST (rotated each session read). */
  csrfToken: string | null
  oauthProviders: string[]
  /** Login modal visibility (the modal lives in the client shell). */
  loginOpen: boolean
  setSession: (s: SessionPayload) => void
  openLogin: () => void
  closeLogin: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  email: null,
  emailVerified: false,
  tier: 'free',
  csrfToken: null,
  oauthProviders: [],
  loginOpen: false,
  setSession: (s) =>
    set({
      status: !s.enabled ? 'disabled' : s.authenticated ? 'authed' : 'anon',
      email: s.email ?? null,
      emailVerified: Boolean(s.emailVerified),
      tier: s.tier ?? 'free',
      csrfToken: s.csrfToken ?? null,
      oauthProviders: s.oauthProviders ?? [],
    }),
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
}))
