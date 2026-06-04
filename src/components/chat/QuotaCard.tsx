'use client'

import Link from 'next/link'
import { useAuthStore } from '@/lib/auth/authStore'
import { useChatStore } from '@/lib/chat/state'
import type { ChatCta } from '@/lib/shared/types'
import styles from './QuotaCard.module.css'

/**
 * Buttons for a quota/login CTA. A button with `*Action === 'openLogin'` opens
 * the in-app auth modal (closing any quota modal first, so only one dialog is
 * ever mounted); otherwise it's a link to `*Href`. Shared by the in-transcript
 * QuotaCard and the QuotaCtaModal so the copy/behavior stays in one place.
 */
export function QuotaCtaActions({ cta }: { cta: ChatCta }) {
  const openLogin = useAuthStore((s) => s.openLogin)
  const closeQuotaCta = useChatStore((s) => s.closeQuotaCta)
  const toLogin = () => {
    closeQuotaCta()
    openLogin()
  }
  return (
    <div className={styles.actions}>
      {cta.primaryAction === 'openLogin' ? (
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={toLogin}>
          {cta.primaryLabel}
        </button>
      ) : cta.primaryHref ? (
        <Link className={`${styles.btn} ${styles.primary}`} href={cta.primaryHref}>
          {cta.primaryLabel}
        </Link>
      ) : null}
      {cta.secondaryAction === 'openLogin' ? (
        <button type="button" className={styles.btn} onClick={toLogin}>
          {cta.secondaryLabel}
        </button>
      ) : cta.secondaryLabel && cta.secondaryHref ? (
        <Link className={styles.btn} href={cta.secondaryHref}>
          {cta.secondaryLabel}
        </Link>
      ) : null}
    </div>
  )
}

/**
 * In-transcript card rendering a quota/login CTA. Persists in chat history (the
 * one-shot modal is QuotaCtaModal). Plain text only — no user input is echoed.
 */
export default function QuotaCard({ cta }: { cta: ChatCta }) {
  return (
    <div className={styles.card} role="note">
      <h3 className={styles.title}>{cta.title}</h3>
      <p className={styles.body}>{cta.body}</p>
      <QuotaCtaActions cta={cta} />
      {cta.resetsInHours != null && (
        <p className={styles.reset}>Your free requests reset in about {cta.resetsInHours}h.</p>
      )}
    </div>
  )
}
