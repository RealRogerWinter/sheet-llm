'use client'

import { useEffect, useRef, useState } from 'react'
import type { Span } from '@/lib/music/types'
import { SLUR_KINDS, type SlurKind } from '@/lib/music/spans'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './SlurPopover.module.css'
import type { HairpinEndOption } from './HairpinPopover'

/**
 * Patch shape emitted from the popover. Mirrors the M12-PR-1 op
 * surface:
 *  - insert: caller dispatches insertSlur against the live selection
 *    (start event) and the chosen end event.
 *  - remove: caller dispatches removeSlur by id.
 *
 * staffIdx / voiceIdx are NOT in the patch — they follow the resolved
 * start event location (the parent computes them from the live
 * selection, which is the start of the slur). Slurs have NO terminal
 * dynamics — those are hairpin-specific.
 */
export type SlurPopoverPatch =
  | {
      kind: 'insert'
      slurKind: SlurKind
      endEventId: string
      placement?: 'above' | 'below' | 'default'
    }
  | { kind: 'remove'; id: string }

/**
 * End-event option as rendered in the dropdown. Aliased to
 * HairpinEndOption so both span popovers consume the same structural
 * shape — the parent's `buildAvailableEnds` helper returns this type
 * and both popovers accept it without a cast.
 */
export type SlurEndOption = HairpinEndOption

export interface SlurPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Slurs already attached to the same (staff, voice). Each renders as
   * a small chip with a × button so the user can remove without
   * leaving the popover. Caller filters upstream.
   */
  existingSlurs: ReadonlyArray<Span & { kind: SlurKind }>
  /**
   * Subsequent events on the same voice available as the slur's end
   * target. Caller builds this list; popover renders as a dropdown.
   * Empty array disables the Apply button.
   */
  availableEnds: ReadonlyArray<SlurEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label, used in the
   * existing-slurs summary so multiple slurs on one voice are
   * distinguishable. When omitted, summaries fall back to the kind
   * label only.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: SlurPopoverPatch) => void
}

const SLUR_LABEL: Record<SlurKind, string> = {
  slur: 'Slur (legato curve)',
  'phrase-slur': 'Phrase slur (broader curve)',
}

export default function SlurPopover({
  open,
  anchorX,
  anchorY,
  existingSlurs,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: SlurPopoverProps) {
  const [slurKind, setSlurKind] = useState<SlurKind>('slur')
  const [endEventId, setEndEventId] = useState<string>('')
  const [placement, setPlacement] = useState<'' | 'above' | 'below' | 'default'>('')
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  // Default end to the FIRST available subsequent event; the user
  // usually wants the slur to extend at least one note ahead.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setSlurKind('slur')
      setEndEventId(availableEnds[0]?.eventId ?? '')
      setPlacement('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, availableEnds])

  // Derived effective end. When the parent's selection changes while
  // the popover is open, `availableEnds` rebuilds; the stored
  // `endEventId` state may now point at an event that's no longer in
  // the dropdown. Deriving on every render (rather than snapping via
  // setState-in-effect, which lints + double-renders) clamps to the
  // first available end ONLY when the stored value is non-empty AND
  // no longer in the set. Explicit-empty (user picked the placeholder)
  // is preserved so Apply stays disabled.
  const effectiveEndEventId =
    endEventId === ''
      ? ''
      : availableEnds.some((e) => e.eventId === endEventId)
        ? endEventId
        : availableEnds[0]?.eventId ?? ''

  const canSubmit = effectiveEndEventId !== ''

  function submit() {
    if (!canSubmit) return
    const patch: Extract<SlurPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      slurKind,
      endEventId: effectiveEndEventId,
    }
    if (placement !== '') patch.placement = placement
    onPatch(patch)
    // Clear placement so a rapid second Apply doesn't silently
    // duplicate the placement choice — kind + end stay sticky so a
    // common "slur this run, then slur the next" workflow re-uses
    // them.
    setPlacement('')
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingSlurs.length > 0 ? 440 : 340}
      estimatedWidth={400}
      ariaLabel="Slur"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Slur (legato curve / phrase mark)</div>

      {existingSlurs.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul className={styles.existingList} role="list" aria-label="Existing slurs">
            {existingSlurs.map((s, idx) => {
              const summary = summarizeSlur(s, eventPositions)
              // Lift id into a local const so the non-null path is
              // proved by TypeScript narrowing rather than a `!` 5
              // lines from the guard. A future edit that widens the
              // guard would correctly fail to compile instead of
              // silently regressing to runtime undefined.
              const id = s.id
              return (
                <li
                  key={id ?? `__noid:${idx}:${s.startEventId}:${s.endEventId}`}
                  className={styles.existingRow}
                >
                  <span className={styles.existingSummary} title={summary}>
                    {summary}
                  </span>
                  {id !== undefined && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      title="Remove this slur"
                      aria-label={`Remove slur ${summary}`}
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
        <div className={popoverStyles.sectionLabel}>Add new slur (start = selected note)</div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Kind</span>
            <select
              ref={firstControlRef}
              className={styles.input}
              value={slurKind}
              aria-label="Slur kind"
              onChange={(e) => setSlurKind(e.target.value as SlurKind)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            >
              {SLUR_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SLUR_LABEL[k]}
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

/**
 * Human-readable one-line summary of a slur for the existing-list row.
 * Includes start→end positional info when positions is provided so
 * multiple slurs on the same voice are distinguishable.
 */
function summarizeSlur(
  s: Span & { kind: SlurKind },
  positions?: ReadonlyMap<string, string>,
): string {
  const word = s.kind === 'phrase-slur' ? 'phrase' : 'slur'
  const startPos = positions?.get(s.startEventId)
  const endPos = positions?.get(s.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  return `${word}${positionTag}`
}
