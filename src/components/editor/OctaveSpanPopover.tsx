'use client'

import { useEffect, useRef, useState } from 'react'
import type { Span } from '@/lib/music/types'
import { OCTAVE_SPAN_KINDS, type OctaveSpanKind } from '@/lib/music/spans'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './OctaveSpanPopover.module.css'
import type { HairpinEndOption } from './HairpinPopover'

/**
 * Patch shape emitted from the OctaveSpanPopover (M20-PR-4). Mirrors
 * the M20-PR-1 op surface — caller dispatches against the live
 * selection (start event) and the chosen end event.
 *
 * staffIdx / voiceIdx are NOT in the patch — they follow the resolved
 * start event location (the parent computes them from the live
 * selection, which is the start of the octave span).
 */
export type OctaveSpanPopoverPatch =
  | {
      kind: 'insert'
      octaveKind: OctaveSpanKind
      endEventId: string
      placement?: 'above' | 'below' | 'default'
    }
  | { kind: 'remove'; id: string }

/**
 * End-event option as rendered in the dropdown. Aliased to
 * HairpinEndOption since the structural shape is the same.
 */
export type OctaveSpanEndOption = HairpinEndOption

export interface OctaveSpanPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Octave spans already attached to the same (staff, voice). Each
   * renders as a small chip with a × button so the user can remove
   * without leaving the popover. Caller filters upstream.
   */
  existingOctaveSpans: ReadonlyArray<Span & { kind: OctaveSpanKind }>
  /**
   * Subsequent events on the same voice available as the span's end
   * target. Caller builds this list; popover renders as a dropdown.
   * Empty array disables the Apply button.
   */
  availableEnds: ReadonlyArray<OctaveSpanEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label, used in the
   * existing-spans summary so multiple spans on one voice are
   * distinguishable.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: OctaveSpanPopoverPatch) => void
}

const OCTAVE_LABEL: Record<OctaveSpanKind, string> = {
  '8va': '8va — one octave UP (above the staff)',
  '8vb': '8vb — one octave DOWN (below the staff)',
  '15ma': '15ma — two octaves UP',
  '15mb': '15mb — two octaves DOWN',
}

export default function OctaveSpanPopover({
  open,
  anchorX,
  anchorY,
  existingOctaveSpans,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: OctaveSpanPopoverProps) {
  const [octaveKind, setOctaveKind] = useState<OctaveSpanKind>('8va')
  const [endEventId, setEndEventId] = useState<string>('')
  const [placement, setPlacement] = useState<'' | 'above' | 'below' | 'default'>('')
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setOctaveKind('8va')
      setEndEventId(availableEnds[0]?.eventId ?? '')
      setPlacement('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, availableEnds])

  // Derived effective end — same pattern as SlurPopover / HairpinPopover /
  // TempoSpanPopover. Clamp stale endEventId to the first available when
  // the parent's selection changes mid-open; preserve explicit-empty so
  // Apply stays disabled when the user picked the placeholder.
  const effectiveEndEventId =
    endEventId === ''
      ? ''
      : availableEnds.some((e) => e.eventId === endEventId)
        ? endEventId
        : availableEnds[0]?.eventId ?? ''

  const canSubmit = effectiveEndEventId !== ''

  function submit() {
    if (!canSubmit) return
    const patch: Extract<OctaveSpanPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      octaveKind,
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
      estimatedHeight={existingOctaveSpans.length > 0 ? 460 : 360}
      estimatedWidth={400}
      ariaLabel="Octave span"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Octave span (8va / 8vb / 15ma / 15mb)
      </div>

      {existingOctaveSpans.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul
            className={styles.existingList}
            role="list"
            aria-label="Existing octave spans"
          >
            {existingOctaveSpans.map((o, idx) => {
              const summary = summarizeOctaveSpan(o, eventPositions)
              const id = o.id
              return (
                <li
                  key={id ?? `__noid:${idx}:${o.startEventId}:${o.endEventId}`}
                  className={styles.existingRow}
                >
                  <span className={styles.existingSummary} title={summary}>
                    {summary}
                  </span>
                  {id !== undefined && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      title="Remove this octave span"
                      aria-label={`Remove octave span ${summary}`}
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
          Add new octave span (start = selected note)
        </div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Kind</span>
            <select
              ref={firstControlRef}
              className={styles.input}
              value={octaveKind}
              aria-label="Octave span kind"
              onChange={(e) => setOctaveKind(e.target.value as OctaveSpanKind)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            >
              {OCTAVE_SPAN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {OCTAVE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>End at</span>
            <select
              className={styles.input}
              value={effectiveEndEventId}
              aria-label="End event"
              aria-invalid={effectiveEndEventId === ''}
              onChange={(e) => setEndEventId(e.target.value)}
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
              <option value="">— (auto: 8va/15ma above, 8vb/15mb below)</option>
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

/**
 * Human-readable one-line summary of an octave span for the existing-
 * list row. Includes start→end positional info when positions is
 * provided so multiple spans on the same voice are distinguishable.
 */
function summarizeOctaveSpan(
  o: Span & { kind: OctaveSpanKind },
  positions?: ReadonlyMap<string, string>,
): string {
  const startPos = positions?.get(o.startEventId)
  const endPos = positions?.get(o.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  return `${o.kind}${positionTag}`
}
