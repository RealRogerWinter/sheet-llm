'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { refreshSession, verifyEmail } from '@/lib/auth/authClient'
import styles from '@/components/auth/AuthPage.module.css'

type Phase = 'verifying' | 'ok' | 'error'

/**
 * POST-on-landing email verification. The emailed link is a plain GET to this
 * page; the single-use token is only CONSUMED by the POST this page fires on
 * load — so inbox scanners / link-prefetchers (GET only) can't burn the token.
 * A ref guards against React StrictMode's double-invoke in dev.
 */
export default function VerifyEmailContent() {
  const token = useSearchParams().get('token')
  const [phase, setPhase] = useState<Phase>('verifying')
  const [message, setMessage] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void (async () => {
      if (!token) {
        setPhase('error')
        setMessage('This verification link is invalid.')
        return
      }
      await refreshSession() // CSRF token
      const res = await verifyEmail(token)
      if (res.ok) {
        setPhase('ok')
      } else {
        setPhase('error')
        setMessage(res.message)
      }
    })()
  }, [token])

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Link href="/" className={styles.brand}>
          sheet-llm
        </Link>
        {phase === 'verifying' && (
          <>
            <h1 className={styles.title}>Verifying…</h1>
            <p className={styles.status}>Confirming your email address.</p>
          </>
        )}
        {phase === 'ok' && (
          <>
            <h1 className={styles.title}>Email verified</h1>
            <div className={styles.success}>Thanks — your email address is confirmed.</div>
            <p className={styles.footer}>
              <Link href="/">Go to sheet-llm</Link>
            </p>
          </>
        )}
        {phase === 'error' && (
          <>
            <h1 className={styles.title}>Verification failed</h1>
            <div role="alert" className={styles.error}>
              {message}
            </div>
            <p className={styles.footer}>
              <Link href="/">Back to sheet-llm</Link>
            </p>
          </>
        )}
      </div>
    </main>
  )
}
