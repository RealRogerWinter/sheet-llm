'use client'

import { useAuthStore, type SessionPayload } from './authStore'
import { errorMessageFromResponse } from './authMessages'

const CHANNEL_NAME = 'sl_auth'
export const AUTH_CHANNEL_NAME = CHANNEL_NAME

// undefined = not yet tried; null = BroadcastChannel unsupported (Safari private, SSR).
let postChannel: BroadcastChannel | null | undefined

function channel(): BroadcastChannel | null {
  if (postChannel === undefined) {
    try {
      postChannel = new BroadcastChannel(CHANNEL_NAME)
    } catch {
      postChannel = null
    }
  }
  return postChannel ?? null
}

/** Notify OTHER tabs that auth state changed so they re-hydrate. */
export function broadcastAuthChange(): void {
  try {
    channel()?.postMessage(1)
  } catch {
    // unsupported — cross-tab sync is best-effort
  }
}

/** Honor a response's identity-scoped `clearLocalStorage` directive. */
function applyClearDirective(body: unknown): void {
  const keys = (body as { clearLocalStorage?: unknown })?.clearLocalStorage
  if (!Array.isArray(keys)) return
  for (const key of keys) {
    if (typeof key !== 'string') continue
    try {
      window.localStorage.removeItem(key)
    } catch {
      // localStorage unavailable
    }
  }
}

/** Read the live session and push it into the store. */
export async function refreshSession(): Promise<SessionPayload> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
  const payload = (await res.json()) as SessionPayload
  useAuthStore.getState().setSession(payload)
  return payload
}

export type AuthResult = { ok: true } | { ok: false; message: string }

function csrfHeader(): Record<string, string> {
  const token = useAuthStore.getState().csrfToken
  return token ? { 'x-csrf-token': token } : {}
}

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...csrfHeader() },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
}

/** POST a mutation, then re-sync the session + broadcast to other tabs. */
async function mutateThenSync(path: string, body: Record<string, unknown>): Promise<AuthResult> {
  const res = await authPost(path, body)
  if (!res.ok) return { ok: false, message: await errorMessageFromResponse(res) }
  try {
    applyClearDirective(await res.clone().json())
  } catch {
    // no/empty body — fine
  }
  await refreshSession()
  broadcastAuthChange()
  return { ok: true }
}

export async function login(email: string, password: string, rememberMe: boolean): Promise<AuthResult> {
  return mutateThenSync('/api/auth/login', { email, password, rememberMe })
}

export async function signup(email: string, password: string): Promise<AuthResult> {
  return mutateThenSync('/api/auth/signup', { email, password })
}

export async function logout(): Promise<AuthResult> {
  return mutateThenSync('/api/auth/logout', {})
}

/**
 * Migrate the browser's pre-login anonymous sessions onto the just-logged-in
 * account (the post-login "Keep my work" choice). Best-effort: returns the number
 * of sessions migrated, or 0 on any failure — the current work is already loaded
 * locally regardless. Unlike the other mutators it does NOT re-sync the session
 * (auth state is unchanged — the user is already logged in).
 */
export async function adoptAnonWork(): Promise<number> {
  try {
    const res = await authPost('/api/auth/adopt-anon-work', {})
    if (!res.ok) return 0
    const body = (await res.json().catch(() => ({}))) as { migrated?: number }
    return typeof body.migrated === 'number' ? body.migrated : 0
  } catch {
    return 0
  }
}

export async function logoutAllDevices(): Promise<AuthResult> {
  return mutateThenSync('/api/auth/logout-all', {})
}

/** Always succeeds from the UI's view (server is always-200, no enumeration). */
export async function forgotPassword(email: string): Promise<AuthResult> {
  const res = await authPost('/api/auth/forgot', { email })
  if (!res.ok) return { ok: false, message: await errorMessageFromResponse(res) }
  return { ok: true }
}

export async function resetPassword(token: string, password: string): Promise<AuthResult> {
  return mutateThenSync('/api/auth/reset', { token, password })
}

export async function verifyEmail(token: string): Promise<AuthResult> {
  return mutateThenSync('/api/auth/verify-email', { token })
}

export async function resendVerification(): Promise<AuthResult> {
  const res = await authPost('/api/auth/verify-email/send', {})
  if (!res.ok) return { ok: false, message: await errorMessageFromResponse(res) }
  return { ok: true }
}

export interface ActiveSession {
  id: string
  createdAt: number
  lastUsedAt: number
  userAgent: string | null
  ip: string | null
  current: boolean
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
  return mutateThenSync('/api/auth/change-password', { currentPassword, newPassword })
}

export async function changeEmail(newEmail: string, currentPassword: string): Promise<AuthResult> {
  return mutateThenSync('/api/auth/change-email', { newEmail, currentPassword })
}

export async function fetchSessions(): Promise<ActiveSession[]> {
  const res = await fetch('/api/auth/sessions', { credentials: 'same-origin', cache: 'no-store' })
  if (!res.ok) return []
  const body = (await res.json()) as { sessions?: ActiveSession[] }
  return Array.isArray(body.sessions) ? body.sessions : []
}

/** Revoke one session by id (then re-sync — handles revoking the current one). */
export async function revokeSession(id: string): Promise<AuthResult> {
  return mutateThenSync('/api/auth/sessions/revoke', { id })
}
