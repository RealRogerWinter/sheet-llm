'use client'

import { useRef } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { getStaffCount, getStaffClef, secondStaffHasContent } from '@/lib/music/scoreAccessors'
import styles from './StavesControl.module.css'

type Mode = 'single' | 'grand'

interface Segment {
  mode: Mode
  label: string
  title: string
}

const SEGMENTS: Segment[] = [
  { mode: 'single', label: 'Single', title: 'One staff' },
  { mode: 'grand', label: 'Grand', title: 'Grand staff (two staves, bar-aligned)' },
]

/**
 * Segmented control swapping the editor between single and grand-staff
 * mode. Schema, edit ops (`addStaff` / `removeStaff`), and renderer all
 * already support `secondStaff`; this control is the only UI surface for
 * toggling it from the editor.
 *
 * Grand → Single is destructive when the bass staff has notes. Rather
 * than blocking with a modal, we fire the remove and surface the
 * existing UndoToast with an "Undo" button — the action is fully
 * undo-reversible and modal friction on an undoable action is
 * paternalistic.
 */
export default function StavesControl() {
  const editedScore = useChatStore((s) => s.editedScore)
  const applyEdit = useChatStore((s) => s.applyEdit)
  const pending = useChatStore((s) => s.pending)
  const showStatusMessage = useChatStore((s) => s.showStatusMessage)
  const showUndoToast = useChatStore((s) => s.showUndoToast)
  const containerRef = useRef<HTMLDivElement>(null)

  if (!editedScore) return null

  const currentMode: Mode = getStaffCount(editedScore) === 2 ? 'grand' : 'single'
  const primaryClef = getStaffClef(editedScore, 0)

  function activate(mode: Mode) {
    if (!editedScore) return
    if (mode === currentMode) return
    if (mode === 'grand') {
      // Default the new staff to bass; if the primary is bass (unusual
      // but legal), default the new staff to treble so the user gets a
      // complementary clef rather than two basses.
      applyEdit({ kind: 'addStaff', clef: primaryClef === 'bass' ? 'treble' : 'bass' })
      showStatusMessage(`Added ${primaryClef === 'bass' ? 'treble' : 'bass'} staff`)
    } else {
      const hasContent = secondStaffHasContent(editedScore)
      applyEdit({ kind: 'removeStaff', staffIdx: 1 })
      if (hasContent) {
        showUndoToast('Bass staff removed')
      } else {
        showStatusMessage('Removed empty bass staff')
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (pending) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      activate('single')
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      activate('grand')
    }
  }

  return (
    <div className={styles.group}>
      <span className={styles.label}>Staves</span>
      <div
        ref={containerRef}
        className={styles.segments}
        role="radiogroup"
        aria-label="Staves"
        onKeyDown={onKeyDown}
      >
        {SEGMENTS.map((seg) => {
          const isActive = seg.mode === currentMode
          return (
            <button
              key={seg.mode}
              type="button"
              role="radio"
              aria-checked={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`${styles.segment} ${isActive ? styles.active : ''}`}
              title={seg.title}
              disabled={pending}
              onClick={() => activate(seg.mode)}
            >
              {seg.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
