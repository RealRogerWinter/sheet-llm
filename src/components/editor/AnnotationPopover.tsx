'use client'

import { useRef, useState, useEffect } from 'react'
import type { Annotation, AnnotationStyle } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './AnnotationPopover.module.css'

/**
 * A click on Apply emits user INTENT (insert a new annotation) — not a
 * pre-resolved op. The caller (NoteFloatingMenu) re-reads the live
 * store at patch time to dispatch insertAnnotation. The `remove` patch
 * carries the id of an existing annotation that the user clicked an
 * "×" button for.
 *
 * Matches the M3-PR-4 TechniquePopover model: keep the popover free of
 * chat-store concerns so closure-staleness on rapid clicks can't
 * overwrite valid data.
 */
export type AnnotationPopoverPatch =
  | {
      kind: 'insert'
      text: string
      style: AnnotationStyle
      position: Annotation['target']['position']
    }
  | { kind: 'remove'; id: string }

export interface AnnotationPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Annotations attached to the SELECTED event (or the measure when
   * selection is measure-level). Rendered as a small list with "×"
   * buttons so the user can drop one without leaving the popover.
   */
  existingAnnotations: ReadonlyArray<Annotation>
  onClose: () => void
  onPatch: (patch: AnnotationPopoverPatch) => void
}

const STYLE_OPTIONS: Array<{ value: AnnotationStyle; label: string; title: string }> = [
  { value: 'plain', label: 'Plain', title: 'Plain roman text' },
  { value: 'italic', label: 'Italic', title: 'Italicized text' },
  { value: 'bold', label: 'Bold', title: 'Bold emphasis' },
  { value: 'rehearsal-mark', label: 'Rehearsal', title: 'Rehearsal mark (boxed letter)' },
  { value: 'tempo-text', label: 'Tempo', title: 'Tempo text (Allegro, Adagio)' },
  { value: 'expression', label: 'Expression', title: 'Expression mark (cantabile, dolce)' },
]

const POSITION_OPTIONS: Array<{ value: Annotation['target']['position']; label: string }> = [
  { value: 'above', label: 'Above' },
  { value: 'below', label: 'Below' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
]

const MAX_TEXT_LENGTH = 120

export default function AnnotationPopover({
  open,
  anchorX,
  anchorY,
  existingAnnotations,
  onClose,
  onPatch,
}: AnnotationPopoverProps) {
  const [text, setText] = useState('')
  const [style, setStyle] = useState<AnnotationStyle>('expression')
  const [position, setPosition] = useState<Annotation['target']['position']>('above')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Autofocus the text input each time the popover opens so the user
  // can type immediately. The wasOpen ref pattern (M5-PR-3) ensures
  // re-seeding only fires on closed→open transitions; not every render
  // while open.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Reset form state to defaults on each fresh open.
      setText('')
      setStyle('expression')
      setPosition('above')
      // Autofocus runs after the popover mounts.
      queueMicrotask(() => inputRef.current?.focus())
    }
    wasOpen.current = open
  }, [open])

  const trimmedText = text.trim()
  const canSubmit = trimmedText.length > 0 && trimmedText.length <= MAX_TEXT_LENGTH

  function submit() {
    if (!canSubmit) return
    onPatch({ kind: 'insert', text: trimmedText, style, position })
    // Clear the text so a subsequent Apply doesn't duplicate; keep
    // style/position sticky so users adding several rehearsal marks
    // in a row don't have to re-select each time.
    setText('')
    queueMicrotask(() => inputRef.current?.focus())
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingAnnotations.length > 0 ? 380 : 320}
      estimatedWidth={360}
      ariaLabel="Annotation"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Annotation</div>

      {existingAnnotations.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this event</div>
          <ul className={styles.existingList} role="list" aria-label="Existing annotations">
            {existingAnnotations.map((a, idx) => (
              <li
                key={
                  a.id ??
                  // Defensive: when id is absent (an LLM emission
                  // not yet backfilled), fall back to a composite key
                  // that includes the array index so duplicate text +
                  // target combinations don't collide on React's
                  // reconciler. insertAnnotation always mints ids, so
                  // this path is effectively dead.
                  `__noid:${idx}:${a.target.measureIdx}:${a.target.eventIdx ?? -1}`
                }
                className={styles.existingRow}
              >
                <span className={styles.existingText} title={`${a.style} — ${a.target.position}`}>
                  {a.text}
                </span>
                <span className={styles.existingStyle}>{a.style}</span>
                {a.id !== undefined && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    title="Remove this annotation"
                    aria-label={`Remove annotation "${a.text}"`}
                    onClick={() => onPatch({ kind: 'remove', id: a.id! })}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Add new</div>
        <input
          ref={inputRef}
          type="text"
          className={styles.textInput}
          placeholder='e.g. "A", "Allegro", "cantabile"'
          aria-label="Annotation text"
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) {
              e.preventDefault()
              submit()
            }
          }}
        />
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Style</div>
        <div className={styles.styleGrid} role="radiogroup" aria-label="Style">
          {STYLE_OPTIONS.map(({ value, label, title }) => {
            const isActive = style === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                title={title}
                onClick={() => setStyle(value)}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Position</div>
        <div className={styles.positionRow} role="radiogroup" aria-label="Position">
          {POSITION_OPTIONS.map(({ value, label }) => {
            const isActive = position === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                onClick={() => setPosition(value)}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={popoverStyles.primary}
          disabled={!canSubmit}
          onClick={submit}
        >
          Apply
        </button>
      </div>
    </Popover>
  )
}
