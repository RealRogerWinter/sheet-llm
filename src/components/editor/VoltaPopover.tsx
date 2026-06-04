'use client'

import { useEffect, useRef, useState } from 'react'
import type { Volta } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './VoltaPopover.module.css'

/**
 * Patch shape emitted from VoltaPopover. The popover never mutates
 * score state directly — the caller resolves each intent against the
 * snapshotted measure target so mid-popover selection changes don't
 * corrupt the patch (same pattern as M16-PR-4 BarlinePopover).
 *
 * Two intent shapes:
 *   - 'insert' — caller dispatches insertVolta { volta: {...} }.
 *   - 'remove' — caller dispatches removeVolta { id }.
 *
 * NOTE: no `update` patch in v1 — users remove + re-insert to edit
 * a volta's endings/range/hook. The popover's existing-list × button
 * only emits `remove`. updateVolta is wired through the LLM (M17-PR-3)
 * + the op layer (M17-PR-1) but not yet surfaced in this UI.
 */
export type VoltaPopoverPatch =
  | {
      kind: 'insert'
      startMeasureIdx: number
      endMeasureIdx: number
      endings: number[]
      endHook?: 'closed' | 'open'
      text?: string
    }
  | { kind: 'remove'; id: string }

export interface VoltaPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Measure number the popover anchors to (1-indexed for display).
   * Used as the DEFAULT start AND end for new voltas — single-bar
   * voltas are by far the most common case.
   */
  measureIdx: number
  /**
   * Voltas already attached to the score (any range). Each renders
   * as a small chip with a × button so the user can remove without
   * leaving the popover.
   */
  existingVoltas: ReadonlyArray<Volta>
  /**
   * Total measures in the score — used to clamp the start/end
   * inputs.
   */
  measureCount: number
  onClose: () => void
  onPatch: (patch: VoltaPopoverPatch) => void
}

export default function VoltaPopover({
  open,
  anchorX,
  anchorY,
  measureIdx,
  existingVoltas,
  measureCount,
  onClose,
  onPatch,
}: VoltaPopoverProps) {
  const firstControlRef = useRef<HTMLInputElement | null>(null)
  // Default a new volta to the anchor measure (single-bar), 1st ending.
  const [pendingStart, setPendingStart] = useState<string>(String(measureIdx + 1))
  const [pendingEnd, setPendingEnd] = useState<string>(String(measureIdx + 1))
  const [pendingEndings, setPendingEndings] = useState<string>('1')
  const [pendingEndHook, setPendingEndHook] = useState<'' | 'closed' | 'open'>('')

  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Re-seed on close→open transition (wasOpen pattern).
      setPendingStart(String(measureIdx + 1))
      setPendingEnd(String(measureIdx + 1))
      setPendingEndings('1')
      setPendingEndHook('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, measureIdx])

  // Parse + validate the inputs. The popover surfaces validation
  // failure as aria-invalid + disabled Apply; the op-layer rejects
  // the same patterns at dispatch.
  const startN = Number(pendingStart.trim())
  const endN = Number(pendingEnd.trim())
  const startValid =
    Number.isInteger(startN) && startN >= 1 && startN <= measureCount
  const endValid =
    Number.isInteger(endN) && endN >= 1 && endN <= measureCount
  const rangeValid = startValid && endValid && startN <= endN

  // Parse endings: comma-separated digits "1", "1,2", "1, 2, 3".
  // Strip whitespace, reject duplicates / out-of-range.
  const endingsRaw = pendingEndings
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const endingsParsed = endingsRaw.map((s) => Number(s))
  const endingsValid =
    endingsParsed.length >= 1 &&
    endingsParsed.length <= 9 &&
    endingsParsed.every((n) => Number.isInteger(n) && n >= 1 && n <= 9) &&
    new Set(endingsParsed).size === endingsParsed.length

  const canSubmit = rangeValid && endingsValid

  function submit() {
    if (!canSubmit) return
    const patch: Extract<VoltaPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      startMeasureIdx: startN - 1,
      endMeasureIdx: endN - 1,
      endings: endingsParsed,
    }
    if (pendingEndHook !== '') patch.endHook = pendingEndHook
    onPatch(patch)
    // Sticky range (user often adds 1st then 2nd ending to nearby
    // measures); clear endings so they re-enter for the next.
    setPendingEndings('')
  }

  // Filter existing voltas to those touching the anchor measure for
  // a focused list (the user typically wants to edit voltas near
  // their current cursor, not arbitrary ones across the score).
  const nearbyVoltas = existingVoltas.filter(
    (v) => v.startMeasureIdx <= measureIdx && measureIdx <= v.endMeasureIdx,
  )

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingVoltas.length > 0 ? 460 : 380}
      estimatedWidth={440}
      ariaLabel="Voltas"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Voltas — measure {measureIdx + 1}
      </div>

      {nearbyVoltas.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>
            Voltas covering this measure
          </div>
          <ul className={styles.existingList} role="list" aria-label="Existing voltas">
            {nearbyVoltas.map((v) => (
              <li key={v.id} className={styles.existingRow}>
                <span className={styles.existingSummary} title={summarizeVolta(v)}>
                  {summarizeVolta(v)}
                </span>
                <button
                  type="button"
                  className={styles.removeButton}
                  title="Remove this volta"
                  aria-label={`Remove volta endings ${v.endings.join(',')}`}
                  onClick={() => onPatch({ kind: 'remove', id: v.id })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Add new volta</div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Start measure</span>
            <input
              ref={firstControlRef}
              type="text"
              inputMode="numeric"
              className={styles.input}
              value={pendingStart}
              aria-label="Start measure (1-indexed)"
              aria-invalid={!startValid}
              onChange={(e) => setPendingStart(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>End measure</span>
            <input
              type="text"
              inputMode="numeric"
              className={styles.input}
              value={pendingEnd}
              aria-label="End measure (1-indexed)"
              aria-invalid={!endValid || !rangeValid}
              onChange={(e) => setPendingEnd(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Endings (1-9, comma-separated)</span>
            <input
              type="text"
              className={styles.input}
              value={pendingEndings}
              aria-label="Endings list"
              aria-invalid={!endingsValid}
              placeholder='e.g. "1" or "1,2"'
              onChange={(e) => setPendingEndings(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>End hook (optional)</span>
            <select
              className={styles.input}
              value={pendingEndHook}
              aria-label="End hook"
              onChange={(e) =>
                setPendingEndHook(e.target.value as '' | 'closed' | 'open')
              }
            >
              <option value="">— (auto)</option>
              <option value="closed">closed</option>
              <option value="open">open</option>
            </select>
          </label>
        </div>
        <div className={styles.hint}>
          Pair the closing measure with a non-thin endBarline
          (repeat-end / final / double) so the bracket closes
          visually — abcjs only closes voltas on non-thin barlines.
        </div>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Close
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

function summarizeVolta(v: Volta): string {
  const endings = v.endings.join(',')
  const range =
    v.startMeasureIdx === v.endMeasureIdx
      ? `m${v.startMeasureIdx + 1}`
      : `m${v.startMeasureIdx + 1}–${v.endMeasureIdx + 1}`
  const hook = v.endHook ? ` [${v.endHook}]` : ''
  return `[${endings}] ${range}${hook}`
}
