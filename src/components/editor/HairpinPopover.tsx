'use client'

import { useEffect, useRef, useState } from 'react'
import type { Dynamic, Span } from '@/lib/music/types'
import { DynamicSchema } from '@/lib/music/types'
import { HAIRPIN_KINDS, type HairpinKind } from '@/lib/music/spans'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './HairpinPopover.module.css'

/**
 * Patch shape emitted from the popover. Mirrors the M11-PR-2 op
 * surface:
 *  - insert: caller dispatches insertHairpin against the live
 *    selection (start event) and the chosen end event.
 *  - remove: caller dispatches removeHairpin by id.
 *
 * staffIdx / voiceIdx are NOT in the patch — they follow the resolved
 * start event location (the parent computes them from the live
 * selection, which is the start of the hairpin).
 */
export type HairpinPopoverPatch =
  | {
      kind: 'insert'
      hairpinKind: HairpinKind
      endEventId: string
      startDynamic?: Dynamic
      endDynamic?: Dynamic
      placement?: 'above' | 'below' | 'default'
    }
  | { kind: 'remove'; id: string }

/** End-event option as rendered in the dropdown. */
export interface HairpinEndOption {
  eventId: string
  /** Short human label, e.g. "m1 b2 — D4 (quarter)" or "next note". */
  label: string
}

export interface HairpinPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Hairpins already attached to the same (staff, voice). Each
   * renders as a small chip with a × button so the user can remove
   * without leaving the popover. Caller filters upstream.
   */
  existingHairpins: ReadonlyArray<Span & { kind: HairpinKind }>
  /**
   * Subsequent events on the same voice available as the hairpin's
   * end target. Caller builds this list; popover renders as a
   * dropdown. Empty array disables the Apply button.
   */
  availableEnds: ReadonlyArray<HairpinEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label, used in the
   * existing-hairpins summary so multiple wedges on one voice are
   * distinguishable. When omitted, summaries fall back to the kind
   * + dynamic shorthand only.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: HairpinPopoverPatch) => void
}

// 'none' is the "no dynamic" sentinel in the enum; the popover models
// that as the empty-string select option, so filter it out of the
// renderable values.
const DYNAMIC_OPTIONS = DynamicSchema.options.filter((d) => d !== 'none')

const HAIRPIN_LABEL: Record<HairpinKind, string> = {
  'hairpin-cresc': 'Crescendo (<)',
  'hairpin-dim': 'Diminuendo (>)',
}

export default function HairpinPopover({
  open,
  anchorX,
  anchorY,
  existingHairpins,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: HairpinPopoverProps) {
  const [hairpinKind, setHairpinKind] = useState<HairpinKind>('hairpin-cresc')
  const [endEventId, setEndEventId] = useState<string>('')
  const [startDynamic, setStartDynamic] = useState<'' | Dynamic>('')
  const [endDynamic, setEndDynamic] = useState<'' | Dynamic>('')
  const [placement, setPlacement] = useState<'' | 'above' | 'below' | 'default'>('')
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  // Default end to the FIRST available subsequent event; the user
  // usually wants the hairpin to extend at least one note ahead.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setHairpinKind('hairpin-cresc')
      setEndEventId(availableEnds[0]?.eventId ?? '')
      setStartDynamic('')
      setEndDynamic('')
      setPlacement('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, availableEnds])

  // Derived effective end — see SlurPopover for the rationale (avoid
  // setState-in-effect, clamp stale endEventId to the first available
  // when the parent's selection changes mid-open; preserve explicit
  // empty so Apply stays disabled when the user picks the placeholder).
  const effectiveEndEventId =
    endEventId === ''
      ? ''
      : availableEnds.some((e) => e.eventId === endEventId)
        ? endEventId
        : availableEnds[0]?.eventId ?? ''

  const canSubmit = effectiveEndEventId !== ''

  function submit() {
    if (!canSubmit) return
    const patch: Extract<HairpinPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      hairpinKind,
      endEventId: effectiveEndEventId,
    }
    if (startDynamic !== '') patch.startDynamic = startDynamic
    if (endDynamic !== '') patch.endDynamic = endDynamic
    if (placement !== '') patch.placement = placement
    onPatch(patch)
    // Clear the per-hairpin terminal dynamics so a rapid second Apply
    // doesn't silently duplicate them — kind + end stay sticky so a
    // common "cresc to that note, then dim back" workflow re-uses
    // them.
    setStartDynamic('')
    setEndDynamic('')
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingHairpins.length > 0 ? 480 : 380}
      estimatedWidth={400}
      ariaLabel="Hairpin"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Hairpin (crescendo / diminuendo)</div>

      {existingHairpins.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul className={styles.existingList} role="list" aria-label="Existing hairpins">
            {existingHairpins.map((h, idx) => {
              const summary = summarizeHairpin(h, eventPositions)
              // See SlurPopover for the lift-id-into-const rationale.
              const id = h.id
              return (
              <li
                key={id ?? `__noid:${idx}:${h.startEventId}:${h.endEventId}`}
                className={styles.existingRow}
              >
                <span className={styles.existingSummary} title={summary}>
                  {summary}
                </span>
                {id !== undefined && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    title="Remove this hairpin"
                    aria-label={`Remove hairpin ${summary}`}
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
        <div className={popoverStyles.sectionLabel}>Add new hairpin (start = selected note)</div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Kind</span>
            <select
              ref={firstControlRef}
              className={styles.input}
              value={hairpinKind}
              aria-label="Hairpin kind"
              onChange={(e) => setHairpinKind(e.target.value as HairpinKind)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            >
              {HAIRPIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {HAIRPIN_LABEL[k]}
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
            <span className={styles.fieldLabel}>Start dynamic (optional)</span>
            <select
              className={styles.input}
              value={startDynamic}
              aria-label="Start dynamic"
              onChange={(e) => setStartDynamic(e.target.value as '' | Dynamic)}
            >
              <option value="">— none</option>
              {DYNAMIC_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>End dynamic (optional)</span>
            <select
              className={styles.input}
              value={endDynamic}
              aria-label="End dynamic"
              onChange={(e) => setEndDynamic(e.target.value as '' | Dynamic)}
            >
              <option value="">— none</option>
              {DYNAMIC_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
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
 * Human-readable one-line summary of a hairpin for the existing-list row.
 * Includes start→end positional info when the positions map is provided
 * so multiple hairpins on the same voice are distinguishable.
 */
function summarizeHairpin(
  h: Span & { kind: HairpinKind },
  positions?: ReadonlyMap<string, string>,
): string {
  const word = h.kind === 'hairpin-cresc' ? 'cresc' : 'dim'
  const startPos = positions?.get(h.startEventId)
  const endPos = positions?.get(h.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  if (h.startDynamic !== undefined && h.endDynamic !== undefined) {
    const arrow = h.kind === 'hairpin-cresc' ? '<' : '>'
    return `${word} ${h.startDynamic}${arrow}${h.endDynamic}${positionTag}`
  }
  return `${word}${positionTag}`
}
