'use client'

import { useEffect, useRef, useState } from 'react'
import type { Barline } from '@/lib/music/types'
import { BARLINE_KINDS } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './BarlinePopover.module.css'

/**
 * Patch shape emitted from BarlinePopover. The popover never mutates
 * score state directly — the caller re-reads useChatStore.getState()
 * at submit time and dispatches the actual edit op. Mirrors the
 * closure-staleness defense from M3-PR-4 / M5-PR-3 / M13-PR-3.
 *
 * Four intent shapes (one per M16-PR-1 op):
 *   - 'start' — set or clear the LEFT-edge barline. Caller dispatches
 *     setStartBarline { staffIdx?, measureIdx, barline? }.
 *   - 'end' — set or clear the RIGHT-edge barline.
 *   - 'pickup' — set the isPickup boolean.
 *   - 'finalPartial' — set the isFinalPartial boolean.
 */
export type BarlinePopoverPatch =
  | { kind: 'start'; barline: Barline | null }
  | { kind: 'end'; barline: Barline | null }
  | { kind: 'pickup'; isPickup: boolean }
  | { kind: 'finalPartial'; isFinalPartial: boolean }

export interface BarlinePopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * The measure index this popover edits (display in the header for
   * user confirmation: "Barlines — measure 4"). 1-indexed for display.
   */
  measureIdx: number
  /**
   * Current startBarline / endBarline values on the target measure.
   * undefined = default thin (no field). Caller passes the live
   * values; popover only mutates via onPatch.
   */
  startBarline: Barline | undefined
  endBarline: Barline | undefined
  isPickup: boolean
  isFinalPartial: boolean
  onClose: () => void
  onPatch: (patch: BarlinePopoverPatch) => void
}

const BARLINE_LABEL: Record<Barline, string> = {
  thin: 'Thin (default)',
  double: 'Double  ||',
  final: 'Final  |]',
  'repeat-start': 'Repeat start  |:',
  'repeat-end': 'Repeat end  :|',
  'repeat-both': 'Repeat both  ::',
  invisible: 'Invisible',
  dashed: 'Dashed (renders as thin)',
}

export default function BarlinePopover({
  open,
  anchorX,
  anchorY,
  measureIdx,
  startBarline,
  endBarline,
  isPickup,
  isFinalPartial,
  onClose,
  onPatch,
}: BarlinePopoverProps) {
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Local pending selectors for the BARLINE dropdowns. Initialized
  // from the props on closed→open transition (wasOpen pattern, same
  // as SlurPopover / TempoSpanPopover / LyricsPopover). The
  // setState-in-effect lint rule (M12-PR-4) blocks the naive
  // seed-on-every-prop-change pattern, so we use the wasOpen ref
  // gate to re-seed exactly once per open.
  const [pendingStart, setPendingStart] = useState<string>(startBarline ?? '')
  const [pendingEnd, setPendingEnd] = useState<string>(endBarline ?? '')

  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Re-seed the selectors from the current props on each
      // close→open transition. A mid-popover prop change (e.g.
      // caller pushes a new measure selection) does NOT re-seed —
      // the user's in-flight selector edit is preserved.
      setPendingStart(startBarline ?? '')
      setPendingEnd(endBarline ?? '')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, startBarline, endBarline])

  function applyStart() {
    const next = pendingStart === '' ? null : (pendingStart as Barline)
    // Suppress no-op dispatch — saves an undo entry.
    if (next === (startBarline ?? null)) return
    onPatch({ kind: 'start', barline: next })
  }
  function applyEnd() {
    const next = pendingEnd === '' ? null : (pendingEnd as Barline)
    if (next === (endBarline ?? null)) return
    onPatch({ kind: 'end', barline: next })
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={380}
      estimatedWidth={420}
      ariaLabel="Barlines"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Barlines — measure {measureIdx + 1}
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Left edge (startBarline)</div>
        <div className={styles.row}>
          <select
            ref={firstControlRef}
            className={styles.input}
            value={pendingStart}
            aria-label="Start barline kind"
            onChange={(e) => setPendingStart(e.target.value)}
          >
            <option value="">— default (thin)</option>
            {BARLINE_KINDS.map((k) => (
              <option key={k} value={k}>
                {BARLINE_LABEL[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={popoverStyles.primary}
            disabled={pendingStart === (startBarline ?? '')}
            onClick={applyStart}
          >
            Apply
          </button>
        </div>
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Right edge (endBarline)</div>
        <div className={styles.row}>
          <select
            className={styles.input}
            value={pendingEnd}
            aria-label="End barline kind"
            onChange={(e) => setPendingEnd(e.target.value)}
          >
            <option value="">— default (thin)</option>
            {BARLINE_KINDS.map((k) => (
              <option key={k} value={k}>
                {BARLINE_LABEL[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={popoverStyles.primary}
            disabled={pendingEnd === (endBarline ?? '')}
            onClick={applyEnd}
          >
            Apply
          </button>
        </div>
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Anacrusis flags</div>
        <label className={styles.flagRow}>
          <input
            type="checkbox"
            checked={isPickup}
            aria-label="Pickup measure (anacrusis)"
            onChange={(e) => onPatch({ kind: 'pickup', isPickup: e.target.checked })}
          />
          <span>
            Pickup measure (anacrusis) — loosens duration check; the
            measure must contain fewer beats than the meter.
          </span>
        </label>
        <label className={styles.flagRow}>
          <input
            type="checkbox"
            checked={isFinalPartial}
            aria-label="Final partial measure"
            onChange={(e) =>
              onPatch({ kind: 'finalPartial', isFinalPartial: e.target.checked })
            }
          />
          <span>
            Final partial — closing short bar that balances the
            pickup (hymn-tune convention).
          </span>
        </label>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Close
        </button>
      </div>
    </Popover>
  )
}
