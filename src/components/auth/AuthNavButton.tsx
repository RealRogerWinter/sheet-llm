'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import { logout } from '@/lib/auth/authClient'
import styles from './AuthNavButton.module.css'

/**
 * Header auth control. Hydrates client-side (status starts 'loading' → renders
 * nothing until `useAuthSync` reads the session, the ThemeToggle deferred-read
 * pattern; a brief logged-out flash on authed loads is accepted). Hidden
 * entirely when accounts are disabled.
 *   - anon:   Log in (opens the modal) + Sign up (→ /signup)
 *   - authed: the account email (→ /settings) + Log out
 */
export default function AuthNavButton() {
  const status = useAuthStore((s) => s.status)
  const email = useAuthStore((s) => s.email)
  const openLogin = useAuthStore((s) => s.openLogin)
  const [loggingOut, setLoggingOut] = useState(false)

  if (status === 'loading' || status === 'disabled') return null

  if (status === 'authed') {
    return (
      <div className={styles.group}>
        <Link href="/settings" className={styles.email} title={`Account — ${email ?? ''}`}>
          {email ?? 'Account'}
        </Link>
        <button
          type="button"
          className={styles.button}
          disabled={loggingOut}
          onClick={async () => {
            setLoggingOut(true)
            await logout()
            setLoggingOut(false)
          }}
        >
          Log out
        </button>
      </div>
    )
  }

  return (
    <div className={styles.group}>
      <button type="button" className={styles.button} onClick={openLogin}>
        Log in
      </button>
      <Link href="/signup" className={`${styles.button} ${styles.primary}`}>
        Sign up
      </Link>
    </div>
  )
}
