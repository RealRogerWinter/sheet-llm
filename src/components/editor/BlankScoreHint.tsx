'use client'

import { useChatStore } from '@/lib/chat/state'
import styles from './BlankScoreHint.module.css'

/**
 * Quiet helper line under the blank-canvas score on a fresh session.
 * Disappears on the first edit (history grows past length 1) and once
 * any LLM turn lands (`lastImport` is cleared by `resolveRequest`).
 *
 * ARIA-hidden because the StatusStrip's aria-live region carries the
 * "Blank score started" announcement on creation — duplicating it here
 * would make the screen reader speak twice.
 */
export default function BlankScoreHint() {
  const lastImport = useChatStore((s) => s.lastImport)
  const historyPointer = useChatStore((s) => s.historyPointer)
  const visible = lastImport?.format === 'blank' && historyPointer === 0
  if (!visible) return null
  return (
    <p className={styles.hint} aria-hidden="true">
      Press A–G to add a note, 1–8 for a duration, or describe what you want below.
    </p>
  )
}
