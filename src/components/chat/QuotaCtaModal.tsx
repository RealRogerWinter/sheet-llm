'use client'

import { useCallback, useRef } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { useFocusTrap } from '@/components/auth/useFocusTrap'
import authStyles from '@/components/auth/AuthModal.module.css'
import { QuotaCtaActions } from './QuotaCard'
import styles from './QuotaCard.module.css'

/**
 * One-shot modal for a quota/login CTA. Reads the chat store's `quotaCta` slot
 * (set by useSubmitPrompt on a 429/403 carrying a cta). Reuses the AuthModal
 * shell (backdrop/dialog/close) + useFocusTrap. Closing (× / Escape) clears the
 * slot; the persistent in-transcript QuotaCard remains. A new submit also clears
 * the slot (beginRequest), so a stale modal never lingers.
 */
export default function QuotaCtaModal() {
  const cta = useChatStore((s) => s.quotaCta)
  const close = useChatStore((s) => s.closeQuotaCta)
  const dialogRef = useRef<HTMLDivElement>(null)
  const onClose = useCallback(() => close(), [close])
  useFocusTrap(dialogRef, cta != null, onClose)

  if (!cta) return null
  return (
    <div className={authStyles.backdrop}>
      <div
        ref={dialogRef}
        className={authStyles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quota-cta-title"
      >
        <div className={authStyles.form}>
          <h2 id="quota-cta-title" className={authStyles.title}>
            {cta.title}
          </h2>
          <p className={styles.body}>{cta.body}</p>
          <QuotaCtaActions cta={cta} />
          {cta.resetsInHours != null && (
            <p className={styles.reset}>Your free requests reset in about {cta.resetsInHours}h.</p>
          )}
        </div>
        <button type="button" className={authStyles.close} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
    </div>
  )
}
