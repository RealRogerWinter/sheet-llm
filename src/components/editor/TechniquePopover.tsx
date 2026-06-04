'use client'

import type { TechniqueChange, TechniqueKind } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './TechniquePopover.module.css'

/**
 * A click on a technique button is a USER INTENT to toggle that
 * technique at the selection — not a pre-resolved insert / remove.
 * The caller (NoteFloatingMenu) reads LIVE store state at patch time
 * to decide insert-vs-remove. Without this, fast double-clicks on the
 * same button see a stale `markersAtPosition` closure and either
 * insert two duplicate markers or fire a "remove id not found" toast
 * — the same closure-staleness regression that bit M2-PR-5a.
 */
export type TechniquePopoverPatch = { kind: 'toggle'; technique: TechniqueKind }

export interface TechniquePopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Technique changes placed exactly AT the selected position
   * (selection.measureIdx, selection.eventIdx, selection's voice).
   * Drives the active-button highlight + the remove-by-id payload.
   * Usually 0 or 1 entry; multiple are legal for layered transitions.
   */
  markersAtPosition: TechniqueChange[]
  /**
   * The technique currently in effect at the selection — after
   * cancellation semantics (arco cancels pizz → undefined). Drives
   * the "Currently playing: …" header so the user sees the live state
   * regardless of whether a marker is placed at this exact note.
   */
  activeTechnique: TechniqueKind | undefined
  onClose: () => void
  onPatch: (patch: TechniquePopoverPatch) => void
}

/** Conventional notation labels — match TECHNIQUE_TEXT in scoreToAbcWithMap. */
const TECHNIQUE_OPTIONS: Array<{ value: TechniqueKind; label: string; title: string }> = [
  { value: 'pizz', label: 'pizz.', title: 'Pizzicato' },
  { value: 'arco', label: 'arco', title: 'Arco (cancels pizz.)' },
  { value: 'col-legno-battuto', label: 'c.l. batt.', title: 'Col legno battuto' },
  { value: 'col-legno-tratto', label: 'c.l. tr.', title: 'Col legno tratto' },
  { value: 'sul-ponticello', label: 'sul pont.', title: 'Sul ponticello' },
  { value: 'sul-tasto', label: 'sul tasto', title: 'Sul tasto' },
  { value: 'flautando', label: 'flaut.', title: 'Flautando' },
  { value: 'ord', label: 'ord.', title: 'Ordinario (return to normal)' },
  { value: 'snap-pizz', label: 'snap', title: 'Snap pizzicato (Bartók)' },
  { value: 'LH-pizz', label: 'L.H.', title: 'Left-hand pizzicato' },
  { value: 'tremolo', label: 'trem.', title: 'Tremolo (state)' },
  { value: 'mute-on', label: 'con sord.', title: 'Mute on (con sordino)' },
  { value: 'mute-off', label: 'senza sord.', title: 'Mute off (senza sordino)' },
]

const TECHNIQUE_LABEL: Record<TechniqueKind, string> =
  TECHNIQUE_OPTIONS.reduce<Record<TechniqueKind, string>>((acc, o) => {
    acc[o.value] = o.label
    return acc
  }, {} as Record<TechniqueKind, string>)

export default function TechniquePopover({
  open,
  anchorX,
  anchorY,
  markersAtPosition,
  activeTechnique,
  onClose,
  onPatch,
}: TechniquePopoverProps) {
  // Index markers by technique so the active highlight is O(1) per
  // button render.
  const markerByKind = new Map<TechniqueKind, TechniqueChange>()
  for (const m of markersAtPosition) markerByKind.set(m.kind, m)

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={220}
      estimatedWidth={360}
      ariaLabel="Performance technique"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Technique
        {activeTechnique ? (
          <span style={{ float: 'right', fontWeight: 400 }}>
            Active: <em>{TECHNIQUE_LABEL[activeTechnique]}</em>
          </span>
        ) : (
          <span style={{ float: 'right', fontWeight: 400, opacity: 0.6 }}>Active: none</span>
        )}
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Place a marker on the selected note</div>
        <div className={styles.techniqueGrid} role="group" aria-label="Technique">
          {TECHNIQUE_OPTIONS.map(({ value, label, title }) => {
            const existing = markerByKind.get(value)
            const isActive = existing !== undefined
            return (
              <button
                key={value}
                type="button"
                className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                title={`${title}${isActive ? ' — click to remove' : ''}`}
                aria-label={title}
                aria-pressed={isActive}
                onClick={() => onPatch({ kind: 'toggle', technique: value })}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <span style={{ fontSize: 11, color: 'var(--graphite)' }}>
          Markers persist forward until cancelled.
        </span>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Done
        </button>
      </div>
    </Popover>
  )
}
