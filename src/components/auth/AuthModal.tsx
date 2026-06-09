'use client'

import Link from 'next/link'
import { useCallback, useRef, useState, type FormEvent } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import { adoptAnonWork, login, signup } from '@/lib/auth/authClient'
import { clearBackup } from '@/lib/auth/clientBackup'
import { useChatStore } from '@/lib/chat/state'
import { useFocusTrap } from './useFocusTrap'
import { GoogleIcon, GitHubIcon } from './ProviderIcons'
import styles from './AuthModal.module.css'

// Identity-scoped keys cleared when the user DISCARDS pre-login anonymous work
// (device-scoped theme/volume are intentionally NOT in this list).
const DISCARD_KEYS = [
  'sheet-llm:recovery',
  'sheet-llm:coachmark',
  'sheet-llm:editor:zoom',
  'sheet-llm:followPlayback',
]

/**
 * Auth modal — a real focus-trapped `<form>` dialog (NOT a copy of
 * MeasureDeleteConfirmModal: it has a proper focus trap, no global capture-phase
 * key handler that would hijack Enter-submit, and no backdrop-click-close that
 * would eat input). Hosts BOTH the login and signup forms (toggled in place via
 * the auth store's `mode`), so Sign up opens here as a modal rather than routing
 * to the standalone `/signup` page. Correct autocomplete (username /
 * current-password vs new-password). After a successful login the browser's
 * anonymous work is ALWAYS adopted onto the account (SHE-9), independent of
 * whether a score is on screen; the keep-or-discard prompt is now only a UX
 * choice for visible on-screen work, not the mechanism that prevents loss.
 * Signup claims the anon identity in place, so it just closes.
 */
export default function AuthModal() {
  const open = useAuthStore((s) => s.loginOpen)
  const close = useAuthStore((s) => s.closeLogin)
  const mode = useAuthStore((s) => s.mode)
  const setMode = useAuthStore((s) => s.setMode)
  const providers = useAuthStore((s) => s.oauthProviders)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keepDiscard, setKeepDiscard] = useState(false)
  const isSignup = mode === 'signup'

  // Reset all local state on close — the modal is permanently mounted (returns
  // null while closed), so without this a stale keep/discard panel or stale
  // email/password/error would survive a close→reopen. Stable (deps [close]) so
  // the focus trap doesn't re-run and re-steal focus on every keystroke.
  const closeModal = useCallback(() => {
    setEmail('')
    setPassword('')
    setError(null)
    setSubmitting(false)
    setKeepDiscard(false)
    close()
  }, [close])

  useFocusTrap(dialogRef, open, closeModal)

  // Toggle login↔signup in place. Clears the error/keep-discard panel but keeps
  // the typed email/password so switching after a typo isn't punishing.
  const switchMode = useCallback(() => {
    setError(null)
    setKeepDiscard(false)
    setMode(useAuthStore.getState().mode === 'signup' ? 'login' : 'signup')
  }, [setMode])

  if (!open) return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const res = isSignup ? await signup(email, password) : await login(email, password, remember)
    setSubmitting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    // Signup creates a fresh account that adopts the current browser's work IN
    // PLACE (same userId), so there's nothing to reconcile — just finish.
    if (isSignup) {
      closeModal()
      return
    }
    // Login authenticates a DIFFERENT userId than the anonymous one, so the
    // browser's pre-login anon sessions/scores would otherwise stay stranded and
    // never appear in the account's sidebar. Always migrate them onto the account
    // (SHE-9): this MUST NOT depend on a score being visually on screen — logging
    // in from a blank/not-yet-hydrated canvas previously closed the modal silently
    // and never adopted. adoptAnonWork is server-side safe/idempotent and no-ops
    // when there's nothing to adopt, and reads the source anon identity from the
    // verified sl_uid cookie (never from client input). Best-effort.
    try {
      await adoptAnonWork()
    } catch {
      /* ignore — current work (if any) stays on screen */
    }
    // Re-fetch the sidebar so the just-adopted sessions show up now.
    useChatStore.getState().refreshSessions()
    // If there's unsaved local work visible, still offer keep/discard so the user
    // can choose to start fresh in their account; otherwise just finish.
    if (useChatStore.getState().abc) setKeepDiscard(true)
    else closeModal()
  }

  function discardLocalWork() {
    try {
      clearBackup()
    } catch {
      /* ignore */
    }
    for (const key of DISCARD_KEYS) {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    }
    try {
      window.sessionStorage.clear()
    } catch {
      /* ignore */
    }
    // Reboot clean as the now-logged-in user (the session cookie survives).
    window.location.reload()
  }

  function keepLocalWork() {
    // The anon sessions were already migrated onto the account in the login
    // success path (and the sidebar already refreshed), so "Keep my work" just
    // keeps the current score on screen and closes — nothing else to reconcile.
    closeModal()
  }

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        {keepDiscard ? (
          <div className={styles.form}>
            <h2 id="auth-modal-title" className={styles.title}>
              Keep your current work?
            </h2>
            <p className={styles.note}>
              You have unsaved work in this browser from before you signed in. Keep it here, or
              discard it and start fresh in your account.
            </p>
            <button type="button" className={`${styles.btn} ${styles.primary} ${styles.full}`} onClick={keepLocalWork} autoFocus>
              Keep my work
            </button>
            <button type="button" className={`${styles.btn} ${styles.full}`} onClick={discardLocalWork}>
              Discard it
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className={styles.form}>
            <h2 id="auth-modal-title" className={styles.title}>
              {isSignup ? 'Create your account' : 'Log in'}
            </h2>
            {error && (
              <div role="alert" className={styles.error}>
                {error}
              </div>
            )}
            <label className={styles.label}>
              <span>Email</span>
              <input
                className={styles.input}
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className={styles.label}>
              <span>Password</span>
              <input
                className={styles.input}
                type="password"
                name="password"
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                required
                minLength={isSignup ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {isSignup && <span className={styles.hint}>At least 10 characters.</span>}
            </label>
            {!isSignup && (
              <label className={styles.checkbox}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>Keep me signed in</span>
              </label>
            )}
            <button type="submit" className={`${styles.btn} ${styles.primary} ${styles.full}`} disabled={submitting}>
              {isSignup
                ? submitting
                  ? 'Creating…'
                  : 'Create account'
                : submitting
                  ? 'Signing in…'
                  : 'Log in'}
            </button>
            {providers.length > 0 && (
              <div className={styles.oauth}>
                <div className={styles.divider}>
                  <span>or</span>
                </div>
                {providers.includes('google') && (
                  <a className={styles.oauthBtn} href="/api/auth/oauth/google/start">
                    <GoogleIcon />
                    <span>Continue with Google</span>
                  </a>
                )}
                {providers.includes('github') && (
                  <a className={styles.oauthBtn} href="/api/auth/oauth/github/start">
                    <GitHubIcon />
                    <span>Continue with GitHub</span>
                  </a>
                )}
              </div>
            )}
            <div className={styles.links}>
              {isSignup ? (
                <>
                  <span />
                  <button type="button" className={styles.linkBtn} onClick={switchMode}>
                    Already have an account? Log in
                  </button>
                </>
              ) : (
                <>
                  <Link href="/reset" onClick={closeModal}>
                    Forgot password?
                  </Link>
                  <button type="button" className={styles.linkBtn} onClick={switchMode}>
                    Create account
                  </button>
                </>
              )}
            </div>
          </form>
        )}
        <button type="button" className={styles.close} onClick={closeModal} aria-label="Close">
          ×
        </button>
      </div>
    </div>
  )
}
