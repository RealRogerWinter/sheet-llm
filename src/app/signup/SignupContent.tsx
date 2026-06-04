'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import { refreshSession, signup } from '@/lib/auth/authClient'
import { GoogleIcon, GitHubIcon } from '@/components/auth/ProviderIcons'
import styles from '@/components/auth/AuthPage.module.css'

export default function SignupContent() {
  const router = useRouter()
  const status = useAuthStore((s) => s.status)
  const providers = useAuthStore((s) => s.oauthProviders)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch a CSRF token (and current auth state) on mount.
  useEffect(() => {
    void refreshSession()
  }, [])
  // Already signed in → nothing to sign up for.
  useEffect(() => {
    if (status === 'authed') router.replace('/')
  }, [status, router])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const res = await signup(email, password)
    setSubmitting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    router.replace('/')
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Link href="/" className={styles.brand}>
          sheet-llm
        </Link>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>
          Your current work in this browser carries over to your new account.
        </p>
        <form className={styles.form} onSubmit={onSubmit}>
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
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className={styles.hint}>At least 10 characters.</span>
          </label>
          <button type="submit" className={styles.btn} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </form>
        {providers.length > 0 && (
          <div className={styles.oauth}>
            <div className={styles.divider}>
              <span>or</span>
            </div>
            {providers.includes('google') && (
              <a className={`${styles.btn} ${styles.secondary} ${styles.oauthBtn}`} href="/api/auth/oauth/google/start">
                <GoogleIcon />
                <span>Continue with Google</span>
              </a>
            )}
            {providers.includes('github') && (
              <a className={`${styles.btn} ${styles.secondary} ${styles.oauthBtn}`} href="/api/auth/oauth/github/start">
                <GitHubIcon />
                <span>Continue with GitHub</span>
              </a>
            )}
          </div>
        )}
        <p className={styles.footer}>
          Already have an account? <Link href="/">Log in</Link>
        </p>
      </div>
    </main>
  )
}
