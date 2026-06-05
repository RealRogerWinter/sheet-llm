'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { clearBackup } from '@/lib/auth/clientBackup'
import { refreshSession } from '@/lib/auth/authClient'
import { errorMessageFromResponse } from '@/lib/auth/authMessages'
import AccountSettings from '@/components/auth/AccountSettings'
import WalletSettings from '@/components/billing/WalletSettings'
import styles from './SettingsContent.module.css'

interface DeleteReceipt {
  deletedAt: number
  deletedSessions: number
  deletedMessages: number
  deletedVersions: number
  deletedAuthSessions: number
  deletedOauthAccounts: number
  deletedAuthTokens: number
}

/**
 * Minimal GDPR settings UI. Two actions: export everything as JSON,
 * or hard-delete the account. Both gated by the cookie scope — the
 * UI doesn't need to gate further. Delete requires the user to type
 * "DELETE" before the button activates (the server enforces this
 * too via Zod literal validation).
 */
export default function SettingsContent({ legalEnabled = false }: { legalEnabled?: boolean }) {
  const [confirm, setConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [receipt, setReceipt] = useState<DeleteReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Hydrate auth state (for the account section) + obtain a CSRF token.
  useEffect(() => {
    void refreshSession()
  }, [])

  const onDelete = useCallback(async () => {
    if (confirm !== 'DELETE') return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch('/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ confirm: 'DELETE' }),
      })
      if (!res.ok) {
        throw new Error(await errorMessageFromResponse(res))
      }
      const body = (await res.json()) as DeleteReceipt & {
        clearLocalStorage?: string[]
      }
      // Server signals which client-side stores to nuke. Currently
      // just the recovery backup, but the shape is extensible.
      clearBackup()
      if (Array.isArray(body.clearLocalStorage)) {
        for (const key of body.clearLocalStorage) {
          try {
            window.localStorage.removeItem(key)
          } catch {
            // ignored
          }
        }
      }
      setReceipt({
        deletedAt: body.deletedAt,
        deletedSessions: body.deletedSessions,
        deletedMessages: body.deletedMessages,
        deletedVersions: body.deletedVersions,
        deletedAuthSessions: body.deletedAuthSessions,
        deletedOauthAccounts: body.deletedOauthAccounts,
        deletedAuthTokens: body.deletedAuthTokens,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }, [confirm])

  if (receipt) {
    return (
      <main className={styles.page}>
        <h1 className={styles.heading}>Account deleted</h1>
        <p className={styles.lede}>
          Your account and all associated data were permanently removed at{' '}
          {new Date(receipt.deletedAt * 1000).toISOString()}.
        </p>
        <ul className={styles.receipt}>
          <li>{receipt.deletedSessions} sessions</li>
          <li>{receipt.deletedMessages} messages</li>
          <li>{receipt.deletedVersions} score versions</li>
          {receipt.deletedAuthSessions > 0 && (
            <li>{receipt.deletedAuthSessions} login sessions</li>
          )}
          {receipt.deletedOauthAccounts > 0 && (
            <li>{receipt.deletedOauthAccounts} linked accounts</li>
          )}
          {receipt.deletedAuthTokens > 0 && (
            <li>{receipt.deletedAuthTokens} auth tokens</li>
          )}
        </ul>
        <p>
          <Link href="/" className={styles.link}>
            Continue as a new visitor →
          </Link>
        </p>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <p className={styles.lede}>
        <Link href="/" className={styles.link}>
          ← Back to sheet-llm
        </Link>
      </p>
      <h1 className={styles.heading}>Settings</h1>

      <AccountSettings />

      <WalletSettings />

      <section className={styles.section}>
        <h2 className={styles.subheading}>Export my data</h2>
        <p className={styles.lede}>
          Download every session, message, and score version stored against
          your anonymous account as a single JSON file. Soft-deleted
          sessions are included.
        </p>
        <a
          href="/api/me/export"
          download
          className={styles.primaryButton}
          rel="nofollow"
        >
          Download JSON
        </a>
      </section>

      <section className={styles.section}>
        <h2 className={styles.subheading}>Delete my account</h2>
        <p className={styles.lede}>
          Permanently removes your account and every session, message, and
          score version. This cannot be undone — make sure to export first
          if you want a copy.
        </p>
        <p className={styles.lede}>
          Type <code>DELETE</code> to enable the button.
        </p>
        <input
          type="text"
          className={styles.confirmInput}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type DELETE"
          autoComplete="off"
          spellCheck={false}
          aria-label="Type DELETE to confirm"
        />
        <button
          type="button"
          className={styles.dangerButton}
          onClick={() => void onDelete()}
          disabled={confirm !== 'DELETE' || deleting}
        >
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
        {error && (
          <p className={styles.error} role="alert">
            Couldn’t delete account: {error}
          </p>
        )}
      </section>

      {legalEnabled && (
        <p className={styles.lede}>
          <Link href="/terms" className={styles.link}>Terms of Service</Link>
          {' · '}
          <Link href="/privacy" className={styles.link}>Privacy Policy</Link>
        </p>
      )}
      <p className={styles.lede}>
        Open source and built in public on{' '}
        <a
          href="https://github.com/RealRogerWinter/sheet-llm"
          className={styles.link}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        .
      </p>
    </main>
  )
}
