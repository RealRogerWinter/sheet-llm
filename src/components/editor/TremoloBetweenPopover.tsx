'use client'

import { useEffect, useRef, useState } from 'react'
import type { Span } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './TremoloBetweenPopover.module.css'
import type { HairpinEndOption } from './HairpinPopover'

/**
 * Patch shape emitted from the TremoloBetweenPopover (M20-PR-5).
 * Single-kind family; no decorators beyond placement.
 *
 * Distinct from Event.tremolo (single-note repeated tremolo with N
 * slashes through the stem; M2-PR-1) — this is the fingered
 * between-two-notes alternation pattern.
 */
export type TremoloBetweenPopoverPatch =
  | {
      kind: 'insert'
      endEventId: string
      placement?: 'above' | 'below' | 'default'
    }
  | { kind: 'remove'; id: string }

export type TremoloBetweenEndOption = HairpinEndOption

export interface TremoloBetweenPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Between-note tremolos already attached to the same (staff, voice).
   */
  existingTremolos: ReadonlyArray<Span & { kind: 'tremolo-between' }>
  /**
   * Subsequent events on the same voice available as the span's end
   * target. Typically there's just one (the next note) — between-note
   * tremolos almost always span exactly two adjacent notes.
   */
  availableEnds: ReadonlyArray<TremoloBetweenEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: TremoloBetweenPopoverPatch) => void
}

export default function TremoloBetweenPopover({
  open,
  anchorX,
  anchorY,
  existingTremolos,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: TremoloBetweenPopoverProps) {
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

  const effectiveEndEventId =
    endEventId === ''
      ? ''
      : availableEnds.some((e) => e.eventId === endEventId)
        ? endEventId
        : availableEnds[0]?.eventId ?? ''

  const canSubmit = effectiveEndEventId !== ''

  function submit() {
    if (!canSubmit) return
    const patch: Extract<TremoloBetweenPopoverPatch, { kind: 'insert' }> = {
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
      estimatedHeight={existingTremolos.length > 0 ? 440 : 340}
      estimatedWidth={400}
      ariaLabel="Tremolo between two notes"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Tremolo between two notes (fingered tremolo)
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>
          Distinct from a single-note tremolo (slashes through one
          note&rsquo;s stem). This is the fingered tremolo: fast alternation
          between TWO notes.
        </div>
      </div>

      {existingTremolos.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul
            className={styles.existingList}
            role="list"
            aria-label="Existing between-note tremolos"
          >
            {existingTremolos.map((t, idx) => {
              const summary = summarizeTremoloBetween(t, eventPositions)
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
                      title="Remove this between-note tremolo"
                      aria-label={`Remove between-note tremolo ${summary}`}
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
          Add new between-note tremolo (start = selected note)
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

function summarizeTremoloBetween(
  t: Span & { kind: 'tremolo-between' },
  positions?: ReadonlyMap<string, string>,
): string {
  const startPos = positions?.get(t.startEventId)
  const endPos = positions?.get(t.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  return `trem.${positionTag}`
}
