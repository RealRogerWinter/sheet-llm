'use client'

import Link from 'next/link'
import { useCallback, useRef, useState, type FormEvent } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import { login } from '@/lib/auth/authClient'
import { clearBackup } from '@/lib/auth/clientBackup'
import { useChatStore } from '@/lib/chat/state'
import { useFocusTrap } from './useFocusTrap'
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
 * Login modal — a real focus-trapped `<form>` dialog (NOT a copy of
 * MeasureDeleteConfirmModal: it has a proper focus trap, no global capture-phase
 * key handler that would hijack Enter-submit, and no backdrop-click-close that
 * would eat input). Correct autocomplete (username / current-password). After a
 * successful login, if there's unsaved local work, offers keep-or-discard so the
 * anon work is never silently lost.
 */
export default function AuthModal() {
  const open = useAuthStore((s) => s.loginOpen)
  const close = useAuthStore((s) => s.closeLogin)
  const providers = useAuthStore((s) => s.oauthProviders)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keepDiscard, setKeepDiscard] = useState(false)

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

  if (!open) return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const res = await login(email, password, remember)
    setSubmitting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    // Signed in. If there's unsaved local work, ask keep/discard; else finish.
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
            <button type="button" className={`${styles.btn} ${styles.primary} ${styles.full}`} onClick={closeModal} autoFocus>
              Keep my work
            </button>
            <button type="button" className={`${styles.btn} ${styles.full}`} onClick={discardLocalWork}>
              Discard it
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className={styles.form}>
            <h2 id="auth-modal-title" className={styles.title}>
              Log in
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
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className={styles.checkbox}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Keep me signed in</span>
            </label>
            <button type="submit" className={`${styles.btn} ${styles.primary} ${styles.full}`} disabled={submitting}>
              {submitting ? 'Signing in…' : 'Log in'}
            </button>
            {providers.length > 0 && (
              <div className={styles.oauth}>
                <div className={styles.divider}>
                  <span>or</span>
                </div>
                {providers.includes('google') && (
                  <a className={styles.oauthBtn} href="/api/auth/oauth/google/start">
                    Continue with Google
                  </a>
                )}
                {providers.includes('github') && (
                  <a className={styles.oauthBtn} href="/api/auth/oauth/github/start">
                    Continue with GitHub
                  </a>
                )}
              </div>
            )}
            <div className={styles.links}>
              <Link href="/reset" onClick={closeModal}>
                Forgot password?
              </Link>
              <Link href="/signup" onClick={closeModal}>
                Create account
              </Link>
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
