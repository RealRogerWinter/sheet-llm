'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { forgotPassword, refreshSession, resetPassword } from '@/lib/auth/authClient'
import styles from '@/components/auth/AuthPage.module.css'

export default function ResetContent() {
  const token = useSearchParams().get('token')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    void refreshSession() // CSRF token
  }, [])

  async function onRequest(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const res = await forgotPassword(email)
    setSubmitting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    setSent(true) // always-success copy — no account enumeration
  }

  async function onReset(e: FormEvent) {
    e.preventDefault()
    if (submitting || !token) return
    setSubmitting(true)
    setError(null)
    const res = await resetPassword(token, password)
    setSubmitting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    setDone(true)
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Link href="/" className={styles.brand}>
          sheet-llm
        </Link>
        {token ? (
          done ? (
            <>
              <h1 className={styles.title}>Password updated</h1>
              <div className={styles.success}>
                Your password has been changed and every other session was signed out. You can log
                in with it now.
              </div>
              <p className={styles.footer}>
                <Link href="/">Go to sheet-llm</Link>
              </p>
            </>
          ) : (
            <>
              <h1 className={styles.title}>Set a new password</h1>
              <form className={styles.form} onSubmit={onReset}>
                {error && (
                  <div role="alert" className={styles.error}>
                    {error}
                  </div>
                )}
                <label className={styles.label}>
                  <span>New password</span>
                  <input
                    className={styles.input}
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <span className={styles.hint}>At least 10 characters.</span>
                </label>
                <button type="submit" className={styles.btn} disabled={submitting}>
                  {submitting ? 'Updating…' : 'Update password'}
                </button>
              </form>
            </>
          )
        ) : sent ? (
          <>
            <h1 className={styles.title}>Check your email</h1>
            <div className={styles.success}>
              If an account exists for that email, we’ve sent a password-reset link. It expires in
              60 minutes.
            </div>
            <p className={styles.footer}>
              <Link href="/">Back to sheet-llm</Link>
            </p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>Reset your password</h1>
            <p className={styles.subtitle}>Enter your email and we’ll send you a reset link.</p>
            <form className={styles.form} onSubmit={onRequest}>
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
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button type="submit" className={styles.btn} disabled={submitting}>
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
            <p className={styles.footer}>
              Remembered it? <Link href="/">Log in</Link>
            </p>
          </>
        )}
      </div>
    </main>
  )
}
