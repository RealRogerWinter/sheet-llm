'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './UndoToast.module.css'

const TOAST_MS = 2_500

export default function UndoToast() {
  const undoToast = useChatStore((s) => s.undoToast)
  const clearUndoToast = useChatStore((s) => s.clearUndoToast)
  const undo = useChatStore((s) => s.undo)

  useEffect(() => {
    if (!undoToast) return
    const t = setTimeout(() => clearUndoToast(), TOAST_MS)
    return () => clearTimeout(t)
  }, [undoToast, clearUndoToast])

  if (!undoToast) return null

  return (
    <div className={styles.toast} role="status">
      <span className={styles.label}>{undoToast.label}</span>
      <button
        type="button"
        className={styles.undo}
        onClick={() => {
          undo()
          clearUndoToast()
        }}
      >
        Undo
      </button>
    </div>
  )
}
