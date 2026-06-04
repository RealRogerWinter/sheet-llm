'use client'

import { useEffect, useRef, useState } from 'react'
import type { Span } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './TrillLinePopover.module.css'
import type { HairpinEndOption } from './HairpinPopover'

/**
 * Patch shape emitted from the TrillLinePopover (M20-PR-5).
 * Single-kind family; no decorators beyond placement.
 */
export type TrillLinePopoverPatch =
  | {
      kind: 'insert'
      endEventId: string
      placement?: 'above' | 'below' | 'default'
    }
  | { kind: 'remove'; id: string }

export type TrillLineEndOption = HairpinEndOption

export interface TrillLinePopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Trill lines already attached to the same (staff, voice). Each
   * renders as a small chip with a × button.
   */
  existingTrillLines: ReadonlyArray<Span & { kind: 'trill-line' }>
  /**
   * Subsequent events on the same voice available as the span's end
   * target.
   */
  availableEnds: ReadonlyArray<TrillLineEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: TrillLinePopoverPatch) => void
}

export default function TrillLinePopover({
  open,
  anchorX,
  anchorY,
  existingTrillLines,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: TrillLinePopoverProps) {
  const [endEventId, setEndEventId] = useState<string>('')
  const [placement, setPlacement] = useState<'' | 'above' | 'below' | 'default'>('')
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setEndEventId(availableEnds[0]?.eventId ?? '')
      setPlacement('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, availableEnds])

  // Derived effective end — same pattern as other span popovers.
  const effectiveEndEventId =
    endEventId === ''
      ? ''
      : availableEnds.some((e) => e.eventId === endEventId)
        ? endEventId
        : availableEnds[0]?.eventId ?? ''

  const canSubmit = effectiveEndEventId !== ''

  function submit() {
    if (!canSubmit) return
    const patch: Extract<TrillLinePopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      endEventId: effectiveEndEventId,
    }
    if (placement !== '') patch.placement = placement
    onPatch(patch)
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingTrillLines.length > 0 ? 440 : 340}
      estimatedWidth={400}
      ariaLabel="Trill line"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Trill line (tr~~~ extension)
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>
          A trill line extends a trill ornament across N notes.
          Set the start event&rsquo;s ornament to <code>trill</code> via Shift+O
          (or the toolbar) so the leading <code>tr</code> glyph is drawn;
          this popover adds the wavy continuation line.
        </div>
      </div>

      {existingTrillLines.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul
            className={styles.existingList}
            role="list"
            aria-label="Existing trill lines"
          >
            {existingTrillLines.map((t, idx) => {
              const summary = summarizeTrillLine(t, eventPositions)
              const id = t.id
              return (
                <li
                  key={id ?? `__noid:${idx}:${t.startEventId}:${t.endEventId}`}
                  className={styles.existingRow}
                >
                  <span className={styles.existingSummary} title={summary}>
                    {summary}
                  </span>
                  {id !== undefined && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      title="Remove this trill line"
                      aria-label={`Remove trill line ${summary}`}
                      onClick={() => onPatch({ kind: 'remove', id })}
                    >
                      ×
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>
          Add new trill line (start = selected note)
        </div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>End at</span>
            <select
              ref={firstControlRef}
              className={styles.input}
              value={effectiveEndEventId}
              aria-label="End event"
              aria-invalid={effectiveEndEventId === ''}
              onChange={(e) => setEndEventId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            >
              {availableEnds.length === 0 ? (
                <option value="">— (no events available)</option>
              ) : (
                <>
                  <option value="">— (select an end event)</option>
                  {availableEnds.map((opt) => (
                    <option key={opt.eventId} value={opt.eventId}>
                      {opt.label}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Placement (optional)</span>
            <select
              className={styles.input}
              value={placement}
              aria-label="Placement"
              onChange={(e) =>
                setPlacement(e.target.value as '' | 'above' | 'below' | 'default')
              }
            >
              <option value="">— (auto)</option>
              <option value="above">above</option>
              <option value="below">below</option>
              <option value="default">default</option>
            </select>
          </label>
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

function summarizeTrillLine(
  t: Span & { kind: 'trill-line' },
  positions?: ReadonlyMap<string, string>,
): string {
  const startPos = positions?.get(t.startEventId)
  const endPos = positions?.get(t.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  return `trill line${positionTag}`
}
