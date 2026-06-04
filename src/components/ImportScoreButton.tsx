'use client'

import { useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import ImportModal from './import/ImportModal'
import styles from './ImportScoreButton.module.css'

export default function ImportScoreButton() {
  const [open, setOpen] = useState(false)
  const pending = useChatStore((s) => s.pending)

  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={() => setOpen(true)}
        disabled={pending}
        aria-label="Import an existing score"
        aria-haspopup="dialog"
      >
        <span className={styles.icon} aria-hidden="true">↧</span> Import
      </button>
      {open && <ImportModal onClose={() => setOpen(false)} />}
    </>
  )
}
