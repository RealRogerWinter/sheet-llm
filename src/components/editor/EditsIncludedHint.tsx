'use client'

import { useChatStore } from '@/lib/chat/state'
import styles from './EditsIncludedHint.module.css'

interface Props {
  /** Whether the user is currently typing in the prompt bar. */
  active: boolean
}

export default function EditsIncludedHint({ active }: Props) {
  const historyPointer = useChatStore((s) => s.historyPointer)
  const scoreJson = useChatStore((s) => s.scoreJson)
  const hasEdits = scoreJson !== undefined && historyPointer > 0
  if (!active || !hasEdits) return null
  return (
    <p className={styles.hint} role="status">
      Your edits will be included.
    </p>
  )
}
