'use client'

import { useEffect, useRef } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './MeasureDeleteConfirmModal.module.css'

/**
 * Always-confirm gate for deleting whole measures.
 *
 * Renders whenever `useChatStore.pendingMeasureDelete` is set — both
 * measure-delete entry points (the NoteFloatingMenu "Delete measure"
 * button and the ⌘K "Delete selected measure(s)" command) route through
 * `requestMeasureDelete`, which sets that slot rather than mutating the
 * score. Confirming fires the span/marker-safe `dragMeasureRange` delete
 * (via `confirmMeasureDelete`); cancelling clears the slot.
 *
 * The deletion is undoable (it goes through `applyEdit`'s history +
 * undo toast), so this gate is about preventing an *accidental*
 * destructive click, not about irreversibility.
 *
 * Measure indices are 0-based internally; the copy shows 1-based bar
 * numbers because that is how musicians count.
 */
export function MeasureDeleteConfirmModal() {
  const pending = useChatStore((s) => s.pendingMeasureDelete)
  const confirm = useChatStore((s) => s.confirmMeasureDelete)
  const cancel = useChatStore((s) => s.cancelMeasureDelete)
  const deleteBtnRef = useRef<HTMLButtonElement>(null)

  // Esc cancels; Enter confirms. Capture nothing else — this is a modal
  // gate, so global editor shortcuts should not run underneath it.
  useEffect(() => {
    if (!pending) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending, confirm, cancel])

  // Focus the destructive action so Enter/Space act on it predictably,
  // matching the keyboard handler above.
  useEffect(() => {
    if (pending) deleteBtnRef.current?.focus()
  }, [pending])

  if (!pending) return null

  const span = pending.fromEnd - pending.fromStart + 1
  const isRange = span > 1
  const title = isRange
    ? `Delete measures ${pending.fromStart + 1}–${pending.fromEnd + 1}?`
    : `Delete measure ${pending.fromStart + 1}?`
  const body = isRange
    ? `${span} measures will be removed and the following bars shifted left. Any slurs, hairpins, or markers spanning the deleted range are dropped. You can undo this.`
    : `Measure ${pending.fromStart + 1} will be removed and the following bars shifted left. Any slurs, hairpins, or markers spanning it are dropped. You can undo this.`

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mdc-title"
      onMouseDown={(e) => {
        // Click on the backdrop (outside the modal) cancels.
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div className={styles.modal}>
        <div className={styles.header} id="mdc-title">
          {title}
        </div>
        <div className={styles.body}>{body}</div>
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btn}
            onClick={cancel}
            aria-label="Cancel (keep the measure)"
          >
            Cancel
          </button>
          <button
            ref={deleteBtnRef}
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={confirm}
            aria-label={isRange ? 'Delete these measures' : 'Delete this measure'}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
