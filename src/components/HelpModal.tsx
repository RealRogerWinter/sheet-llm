'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { useChatStore } from '@/lib/chat/state'
import {
  QUICK_START_INTRO,
  QUICK_START_STEPS,
  QUICK_START_FOOTER,
} from '@/lib/help/content'
import styles from './HelpModal.module.css'

interface HelpModalProps {
  onClose: () => void
}

export default function HelpModal({ onClose }: HelpModalProps) {
  const toggleCheatSheet = useChatStore((s) => s.toggleCheatSheet)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // Esc to dismiss; the close button takes initial focus. Mirrors the
  // import dialog — a full focus trap is more than this read-only modal
  // needs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    closeBtnRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function openShortcuts() {
    onClose()
    toggleCheatSheet()
  }

  return (
    <div className={styles.scrim} role="presentation" onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="help-title" className={styles.title}>Quick start</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close help"
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.intro}>{QUICK_START_INTRO}</p>
          <ol className={styles.steps}>
            {QUICK_START_STEPS.map((step) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.stepTitle}>{step.title}.</span>{' '}
                {step.body}
              </li>
            ))}
          </ol>
          <p className={styles.hint}>{QUICK_START_FOOTER}</p>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={openShortcuts}>
            Keyboard shortcuts
          </button>
          <Link href="/help" className={styles.primary}>
            Open the full guide →
          </Link>
        </div>
      </div>
    </div>
  )
}
