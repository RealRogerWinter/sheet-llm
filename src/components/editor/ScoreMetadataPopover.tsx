'use client'

import { useEffect, useRef, useState } from 'react'
import type { Score } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './ScoreMetadataPopover.module.css'

/**
 * Patch shape emitted by Save. Each field is independently:
 *   - undefined → field unchanged
 *   - null      → clear an existing value
 *   - string    → set to this value (non-empty; the form rejects ''
 *                 before reaching Save so we never emit '')
 *
 * Mirrors the setScoreMetadata op's accept-shape exactly. The caller
 * (EditorToolbar) dispatches one setScoreMetadata op with the whole
 * patch so the change is atomic in undo history.
 */
export interface ScoreMetadataPatch {
  title?: string | null
  composer?: string | null
  arranger?: string | null
  lyricist?: string | null
  copyright?: string | null
}

export interface ScoreMetadataPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /** Current Score metadata to seed the form. */
  current: Pick<Score, 'title' | 'composer' | 'arranger' | 'lyricist' | 'copyright'>
  onClose: () => void
  onSubmit: (patch: ScoreMetadataPatch) => void
}

/**
 * Field-length caps mirror the Zod schema in lib/music/types.ts:
 *   title 80, composer/arranger/lyricist 120, copyright 200.
 * Enforced via the input's maxLength attribute so the user can't
 * type past the bound — pre-empts schema-validation roundtrips.
 */
const MAX_TITLE = 80
const MAX_NAME = 120
const MAX_COPYRIGHT = 200

const FIELDS = [
  { key: 'title' as const, label: 'Title', max: MAX_TITLE, placeholder: 'Untitled' },
  { key: 'composer' as const, label: 'Composer', max: MAX_NAME, placeholder: 'e.g. J. S. Bach' },
  { key: 'arranger' as const, label: 'Arranger', max: MAX_NAME, placeholder: 'e.g. Liszt (transcription)' },
  { key: 'lyricist' as const, label: 'Lyricist', max: MAX_NAME, placeholder: 'e.g. Verse author' },
  { key: 'copyright' as const, label: 'Copyright', max: MAX_COPYRIGHT, placeholder: '© 2026 Name. All rights reserved.' },
]

type FieldKey = (typeof FIELDS)[number]['key']

export default function ScoreMetadataPopover({
  open,
  anchorX,
  anchorY,
  current,
  onClose,
  onSubmit,
}: ScoreMetadataPopoverProps) {
  const initial = (): Record<FieldKey, string> => ({
    title: current.title ?? '',
    composer: current.composer ?? '',
    arranger: current.arranger ?? '',
    lyricist: current.lyricist ?? '',
    copyright: current.copyright ?? '',
  })

  const [values, setValues] = useState<Record<FieldKey, string>>(initial)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  // Re-seed the form ONLY on closed→open transition so the seed
  // doesn't clobber the user's in-progress edits when the parent
  // re-renders (M5-PR-3 wasOpen pattern).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setValues(initial)
      queueMicrotask(() => titleInputRef.current?.focus())
    }
    wasOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: re-seed only on transition, not on current changes mid-open
  }, [open])

  // Trim BOTH sides of the diff so legacy data with stray whitespace
  // (e.g. composer "Bach " from an older edit) doesn't make the form
  // open with Save spuriously enabled and emit a no-op-looking diff.
  // Self-heals after one Save in any case, but the symmetry keeps the
  // user-intent semantics clean.
  function computePatch(): ScoreMetadataPatch {
    const patch: ScoreMetadataPatch = {}
    for (const { key } of FIELDS) {
      const next = values[key].trim()
      const prev = (current[key] ?? '').toString().trim()
      if (next === prev) continue
      // setScoreMetadata rejects empty strings — encode "cleared" as
      // null so the op handler strips the field.
      patch[key] = next === '' ? null : next
    }
    return patch
  }

  function submit() {
    const patch = computePatch()
    // Even an all-undefined patch is forwarded; the caller can choose
    // to skip dispatching when nothing changed. Symmetric with how
    // other popovers work — the form just reports the user-intent.
    onSubmit(patch)
  }

  const hasChanges = (() => {
    for (const { key } of FIELDS) {
      const next = values[key].trim()
      const prev = (current[key] ?? '').toString().trim()
      if (next !== prev) return true
    }
    return false
  })()

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={460}
      estimatedWidth={420}
      ariaLabel="Score info"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Score info</div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Metadata</div>
        <div className={styles.fields}>
          {FIELDS.map(({ key, label, max, placeholder }) => (
            <label key={key} className={styles.field}>
              <span className={styles.fieldLabel}>{label}</span>
              <input
                ref={key === 'title' ? titleInputRef : undefined}
                type="text"
                className={styles.input}
                value={values[key]}
                maxLength={max}
                placeholder={placeholder}
                aria-label={label}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [key]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hasChanges) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={popoverStyles.primary}
          disabled={!hasChanges}
          onClick={submit}
        >
          Save
        </button>
      </div>
    </Popover>
  )
}
