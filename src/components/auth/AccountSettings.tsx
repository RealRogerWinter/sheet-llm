'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import {
  changeEmail,
  changePassword,
  fetchSessions,
  logoutAllDevices,
  resendVerification,
  revokeSession,
  type ActiveSession,
} from '@/lib/auth/authClient'
import styles from './AccountSettings.module.css'

type Msg = { ok: boolean; text: string } | null

function FormStatus({ msg }: { msg: Msg }) {
  if (!msg) return null
  return (
    <p role="alert" className={msg.ok ? styles.ok : styles.error}>
      {msg.text}
    </p>
  )
}

/**
 * Account-management section of /settings, shown only to authenticated users:
 * email + verification status, change-password, change-email, and the live
 * "active sessions" list (revoke one or all). Self-gates on auth status so it
 * renders nothing for anonymous visitors (who only see export/delete).
 */
export default function AccountSettings() {
  const status = useAuthStore((s) => s.status)
  const email = useAuthStore((s) => s.email)
  const emailVerified = useAuthStore((s) => s.emailVerified)

  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<Msg>(null)

  const [newEmail, setNewEmail] = useState('')
  const [emailPw, setEmailPw] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailMsg, setEmailMsg] = useState<Msg>(null)

  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ActiveSession[]>([])

  useEffect(() => {
    if (status === 'authed') void fetchSessions().then(setSessions)
  }, [status])

  if (status !== 'authed') return null

  async function reloadSessions() {
    setSessions(await fetchSessions())
  }

  async function onChangePassword(e: FormEvent) {
    e.preventDefault()
    if (pwBusy) return
    setPwBusy(true)
    setPwMsg(null)
    const res = await changePassword(curPw, newPw)
    setPwBusy(false)
    if (res.ok) {
      setPwMsg({ ok: true, text: 'Password changed. Other devices were signed out.' })
      setCurPw('')
      setNewPw('')
      void reloadSessions()
    } else {
      setPwMsg({ ok: false, text: res.message })
    }
  }

  async function onChangeEmail(e: FormEvent) {
    e.preventDefault()
    if (emailBusy) return
    setEmailBusy(true)
    setEmailMsg(null)
    const res = await changeEmail(newEmail, emailPw)
    setEmailBusy(false)
    if (res.ok) {
      setEmailMsg({ ok: true, text: 'Email updated — check your new inbox to verify it.' })
      setNewEmail('')
      setEmailPw('')
    } else {
      setEmailMsg({ ok: false, text: res.message })
    }
  }

  async function onResend() {
    setVerifyMsg(null)
    const res = await resendVerification()
    setVerifyMsg(res.ok ? 'Verification email sent.' : res.message)
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.subheading}>Account</h2>

      <div className={styles.row}>
        <span className={styles.muted}>Email</span>
        <span className={styles.value}>
          {email ?? '—'}{' '}
          {emailVerified ? (
            <span className={styles.badgeOk}>verified</span>
          ) : (
            <span className={styles.badgeWarn}>unverified</span>
          )}
        </span>
      </div>
      {!emailVerified && (
        <div className={styles.inline}>
          <button type="button" className={styles.button} onClick={() => void onResend()}>
            Resend verification
          </button>
          {verifyMsg && <span className={styles.muted}>{verifyMsg}</span>}
        </div>
      )}

      <form className={styles.form} onSubmit={onChangePassword}>
        <h3 className={styles.formTitle}>Change password</h3>
        <FormStatus msg={pwMsg} />
        <input
          className={styles.input}
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          required
          value={curPw}
          onChange={(e) => setCurPw(e.target.value)}
          aria-label="Current password"
        />
        <input
          className={styles.input}
          type="password"
          autoComplete="new-password"
          placeholder="New password (at least 10 characters)"
          required
          minLength={10}
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          aria-label="New password"
        />
        <button type="submit" className={styles.button} disabled={pwBusy}>
          {pwBusy ? 'Saving…' : 'Change password'}
        </button>
      </form>

      <form className={styles.form} onSubmit={onChangeEmail}>
        <h3 className={styles.formTitle}>Change email</h3>
        <FormStatus msg={emailMsg} />
        <input
          className={styles.input}
          type="email"
          placeholder="New email"
          required
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          aria-label="New email"
        />
        <input
          className={styles.input}
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          required
          value={emailPw}
          onChange={(e) => setEmailPw(e.target.value)}
          aria-label="Current password to change email"
        />
        <button type="submit" className={styles.button} disabled={emailBusy}>
          {emailBusy ? 'Saving…' : 'Change email'}
        </button>
      </form>

      <div className={styles.form}>
        <h3 className={styles.formTitle}>Active sessions</h3>
        <ul className={styles.sessions}>
          {sessions.map((s) => (
            <li key={s.id} className={styles.sessionRow}>
              <div>
                <div className={styles.value}>
                  {s.current ? 'This device' : s.userAgent ?? 'Unknown device'}
                </div>
                <div className={styles.muted}>
                  Last active {new Date(s.lastUsedAt * 1000).toLocaleString()}
                  {s.ip ? ` · ${s.ip}` : ''}
                </div>
              </div>
              {s.current ? (
                <span className={styles.badgeOk}>current</span>
              ) : (
                <button
                  type="button"
                  className={styles.buttonSmall}
                  onClick={() => void revokeSession(s.id).then(reloadSessions)}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
          {sessions.length === 0 && <li className={styles.muted}>No active sessions.</li>}
        </ul>
        <button
          type="button"
          className={styles.button}
          onClick={() => void logoutAllDevices().then(reloadSessions)}
        >
          Log out all devices
        </button>
      </div>
    </section>
  )
}
