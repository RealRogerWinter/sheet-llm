'use client'

import { useChatStore } from '@/lib/chat/state'
import styles from './ErrorToast.module.css'

export default function ErrorToast() {
  const error = useChatStore((s) => s.error)
  const clearError = useChatStore((s) => s.clearError)

  if (!error) return null

  // Errors persist until the user dismisses them or submits again
  // (beginRequest clears `error`). We deliberately do NOT auto-dismiss:
  // a 6s timer made server errors impossible to read or copy for a bug
  // report. The Copy button puts the full text on the clipboard.
  return (
    <div className={styles.toast} role="alert">
      <span className={styles.message}>{error}</span>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => {
          void navigator.clipboard?.writeText(error)
        }}
        aria-label="Copy error message"
      >
        Copy
      </button>
      <button type="button" className={styles.dismiss} onClick={clearError} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
