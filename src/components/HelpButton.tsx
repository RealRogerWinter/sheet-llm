'use client'

import { useState } from 'react'
import HelpModal from './HelpModal'
import styles from './HelpButton.module.css'

export default function HelpButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={() => setOpen(true)}
        aria-label="Open help and quick start"
        aria-haspopup="dialog"
      >
        <HelpIcon />
        <span className={styles.label}>Help</span>
      </button>
      {open && <HelpModal onClose={() => setOpen(false)} />}
    </>
  )
}

function HelpIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  )
}
