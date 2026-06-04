'use client'

import { useChatStore } from '@/lib/chat/state'
import styles from './EditedPill.module.css'

export default function EditedPill() {
  const historyPointer = useChatStore((s) => s.historyPointer)
  const scoreJson = useChatStore((s) => s.scoreJson)
  if (!scoreJson || historyPointer <= 0) return null
  return (
    <span className={styles.pill} aria-label="Score has been manually edited">
      <span className={styles.icon} aria-hidden="true">✎</span> edited
    </span>
  )
}
