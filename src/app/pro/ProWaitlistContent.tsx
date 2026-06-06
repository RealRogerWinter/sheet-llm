'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import EditionTopbar from '@/components/shell/EditionTopbar'
import styles from './ProWaitlist.module.css'

// mailto fallback when the instance hasn't configured SL_PRO_WAITLIST_NOTIFY.
const FALLBACK_MAILTO =
  'mailto:hello@sheetllm.com?subject=sheet-llm%20Pro%20waitlist&body=Please%20add%20me%20to%20the%20Pro%20waitlist.'

type Status = 'idle' | 'submitting' | 'done' | 'error'

export default function ProWaitlistContent() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (status === 'submitting') return
    setStatus('submitting')
    setMessage('')
    try {
      const res = await fetch('/api/pro-interest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        code?: string
        error?: string
      }
      if (data.ok) {
        setStatus('done')
        setMessage("Thanks — you're on the list. We'll email you the moment Pro is ready.")
        return
      }
      if (data.code === 'not_configured') {
        window.location.href = FALLBACK_MAILTO // waitlist email not wired up here
        setStatus('idle')
        return
      }
      setStatus('error')
      setMessage(data.error ?? 'Something went wrong. Please try again.')
    } catch {
      setStatus('error')
      setMessage('Network error. Please try again.')
    }
  }

  return (
    <>
      <EditionTopbar runhead="Pro" back={false} />
      <main className={styles.page}>
        <h1 className={styles.title}>Pro is coming soon</h1>
      <p className={styles.lede}>
        sheet-llm Pro removes the daily request limit and unlocks larger generations. It&rsquo;s not
        quite ready yet — leave your email and we&rsquo;ll let you know the moment it launches.
      </p>
      {status === 'done' ? (
        <p className={styles.status} role="status">
          {message}
        </p>
      ) : (
        <form className={styles.form} onSubmit={onSubmit}>
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
          <button className={styles.btn} type="submit" disabled={status === 'submitting'}>
            {status === 'submitting' ? 'Joining…' : 'Join the waitlist'}
          </button>
          {status === 'error' && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
        </form>
      )}
      <Link className={styles.back} href="/">
        ← Back to the editor
      </Link>
      </main>
    </>
  )
}
