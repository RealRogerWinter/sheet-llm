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
  /** Auth modal visibility (the modal lives in the client shell). */
  loginOpen: boolean
  /** Which form the (single) auth modal shows — login or signup. */
  mode: AuthMode
  setSession: (s: SessionPayload) => void
  /** Open the modal on the login form. */
  openLogin: () => void
  /** Open the modal on the signup form (so Sign up is a modal, not a page). */
  openSignup: () => void
  /** Switch the open modal between login/signup without closing it. */
  setMode: (mode: AuthMode) => void
  closeLogin: () => void
}

export type AuthMode = 'login' | 'signup'

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  email: null,
  emailVerified: false,
  tier: 'free',
  csrfToken: null,
  oauthProviders: [],
  loginOpen: false,
  mode: 'login',
  setSession: (s) =>
    set({
      status: !s.enabled ? 'disabled' : s.authenticated ? 'authed' : 'anon',
      email: s.email ?? null,
      emailVerified: Boolean(s.emailVerified),
      tier: s.tier ?? 'free',
      csrfToken: s.csrfToken ?? null,
      oauthProviders: s.oauthProviders ?? [],
    }),
  openLogin: () => set({ loginOpen: true, mode: 'login' }),
  openSignup: () => set({ loginOpen: true, mode: 'signup' }),
  setMode: (mode) => set({ mode }),
  closeLogin: () => set({ loginOpen: false }),
}))
