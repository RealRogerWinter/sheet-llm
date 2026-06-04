'use client'

/**
 * Client-side helpers for the recovery-token localStorage backup.
 *
 * Three pieces:
 *  1. installBackupInterceptor() — wraps global `fetch` so any response
 *     carrying `X-Session-Recovery` writes the token into localStorage.
 *  2. bootRestoreIfNeeded() — on app boot, if `document.cookie` lacks
 *     the session cookie AND localStorage has a backup, POSTs to
 *     `/api/auth/restore` and reloads on success.
 *  3. clearBackup() — called explicitly from /me/delete success path
 *     so the just-deleted user can't ghost-restore.
 *
 * Module is intentionally tiny and pure-DOM — no React, no Zustand —
 * so it can be imported anywhere (including from a top-level layout
 * effect that runs before the rest of the React tree mounts).
 */

import {
  RECOVERY_HEADER,
  RECOVERY_STORAGE_KEY,
} from '@/lib/auth/recovery'

// Server sets this (non-httpOnly) alongside the httpOnly session cookie
// (`sl_uid`) in lockstep. Presence in document.cookie ≈ "we have a
// session". The actual JWT lives in sl_uid which JS can't read.
const SESSION_PRESENT_COOKIE = 'sl_present'
const BACKUP_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1y, mirrors cookie

interface StoredBackup {
  token: string
  /** Unix ms — used as a soft TTL guard. Mirrors session cookie maxAge
   *  so the backup can never outlive what the server would accept. */
  exp: number
}

let installed = false

function readBackup(): StoredBackup | null {
  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredBackup>
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null
    }
    if (Date.now() >= parsed.exp) {
      // Stale backup — drop it. The server-side token may also be
      // expired by now; in any case, replaying would 401.
      window.localStorage.removeItem(RECOVERY_STORAGE_KEY)
      return null
    }
    return { token: parsed.token, exp: parsed.exp }
  } catch {
    return null
  }
}

function writeBackup(token: string): void {
  try {
    const payload: StoredBackup = {
      token,
      exp: Date.now() + BACKUP_TTL_MS,
    }
    window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // localStorage unavailable (private mode quirks, quota exceeded);
    // nothing we can do — user just loses the backup-survives-cookie-
    // loss safety net for this session.
  }
}

export function clearBackup(): void {
  try {
    window.localStorage.removeItem(RECOVERY_STORAGE_KEY)
  } catch {
    // ignored
  }
}

/**
 * True iff a chat request is currently in flight (or otherwise holds
 * destructible user state we shouldn't clobber). The chat store at
 * `src/lib/chat/state.ts` mirrors its `pending` flag to globalThis so
 * this module can check it without importing React/Zustand.
 */
function isChatActive(): boolean {
  if (typeof globalThis === 'undefined') return false
  return (globalThis as { __sheetLlmChatActive?: boolean }).__sheetLlmChatActive === true
}

function hasSessionCookie(): boolean {
  // sl_uid itself is httpOnly and invisible to JS by design. The
  // server sets a parallel non-httpOnly `sl_present` cookie in
  // lockstep (see setSessionCookie in src/lib/auth/session.ts) so
  // we can answer "do we have a session?" without exposing the JWT.
  // Same Max-Age as sl_uid, so they expire together; manual clear
  // and Safari ITP both nuke them together too.
  if (typeof document === 'undefined') return false
  const cookies = document.cookie || ''
  if (!cookies) return false
  return cookies
    .split('; ')
    .some((c) => c.startsWith(`${SESSION_PRESENT_COOKIE}=`))
}

/**
 * Wrap global `fetch` so any response carrying `X-Session-Recovery`
 * writes the token into localStorage. Idempotent: safe to call
 * multiple times; subsequent calls are no-ops.
 *
 * MUST be called before any other fetch happens (boot-time effect in
 * a top-level client component). Wraps the bound `fetch`, not
 * `window.fetch` directly, so Next's preflight and the like are
 * captured too.
 */
export function installBackupInterceptor(): void {
  if (installed || typeof globalThis.fetch !== 'function') return
  installed = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args)
    try {
      const token = response.headers.get(RECOVERY_HEADER)
      if (token && token.length > 20) {
        writeBackup(token)
      }
    } catch {
      // Headers can throw on non-conforming Response objects; swallow.
    }
    return response
  }
}

/**
 * On boot, if `localStorage` has a non-expired backup AND we don't
 * appear to have a session cookie, POST to /api/auth/restore. On 204,
 * reload so the rest of the app sees the new cookie. On any failure,
 * fall through to the normal "mint a fresh anonymous identity" path.
 *
 * Returns a promise that resolves when the restore attempt finishes
 * (so callers can `await` before continuing with mount-time work).
 * Doesn't throw — all failure modes are best-effort recovery.
 */
export async function bootRestoreIfNeeded(): Promise<void> {
  if (typeof window === 'undefined') return
  // Critical: short-circuit when the sentinel cookie says we already
  // have a session. Without this guard, every boot would POST to
  // /api/auth/restore even with a valid cookie. The rolling-refresh
  // design (each successful restore mints a NEW recovery token + nonce)
  // means a fresh nonce always passes the server's single-use CAS, so
  // 409 never fires — the only thing breaking the reload loop would be
  // the per-IP rate limiter at 10/5min.
  if (hasSessionCookie()) return
  const backup = readBackup()
  if (!backup) return
  try {
    const res = await fetch('/api/auth/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: backup.token }),
    })
    if (res.status === 204) {
      // New cookie + new recovery token were set. The interceptor
      // already stashed the new recovery token. Reload so the rest of
      // the app uses the fresh cookie — UNLESS a chat request is in
      // flight, in which case a reload would destroy the user's
      // optimistic prompt + in-progress assistant response. The fresh
      // cookie is sent automatically on every subsequent fetch, so
      // skipping the reload only costs us re-running SSR with the now-
      // correct auth context (cosmetic for an active session).
      if (!isChatActive()) {
        window.location.reload()
      }
    } else if (res.status === 401 || res.status === 410 || res.status === 409) {
      // Token bad/expired (401), user GC'd (410), or already consumed
      // (409). In all three cases the backup is no longer useful;
      // dropping it prevents repeated futile attempts.
      clearBackup()
    }
    // 429 — we'll retry on next boot. Don't clear.
    // 5xx — transient; don't clear.
  } catch {
    // Network error or aborted — leave backup in place for next boot.
  }
}
