'use client'

import { useEffect, useRef, useState } from 'react'
import type { Span } from '@/lib/music/types'
import { TEMPO_SPAN_KINDS, type TempoSpanKind } from '@/lib/music/spans'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './TempoSpanPopover.module.css'
import type { HairpinEndOption } from './HairpinPopover'

/**
 * Patch shape emitted from the TempoSpanPopover. Mirrors the M14-PR-1
 * op surface:
 *  - insert: caller dispatches insertTempoSpan against the live
 *    selection (start event) and the chosen end event.
 *  - remove: caller dispatches removeTempoSpan by id.
 *
 * staffIdx / voiceIdx are NOT in the patch — they follow the resolved
 * start event location (the parent computes them from the live
 * selection, which is the start of the tempo span).
 */
export type TempoSpanPopoverPatch =
  | {
      kind: 'insert'
      tempoKind: TempoSpanKind
      endEventId: string
      placement?: 'above' | 'below' | 'default'
      endTempoBpm?: number
      endTempoText?: string
    }
  | { kind: 'remove'; id: string }

/**
 * End-event option as rendered in the dropdown. Aliased to
 * HairpinEndOption since both span popovers consume the same structural
 * shape from the parent's buildAvailableEnds helper.
 */
export type TempoSpanEndOption = HairpinEndOption

export interface TempoSpanPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Tempo spans already attached to the same (staff, voice). Each
   * renders as a small chip with a × button so the user can remove
   * without leaving the popover. Caller filters upstream.
   */
  existingTempoSpans: ReadonlyArray<Span & { kind: TempoSpanKind }>
  /**
   * Subsequent events on the same voice available as the span's end
   * target. Caller builds this list; popover renders as a dropdown.
   * Empty array disables the Apply button.
   */
  availableEnds: ReadonlyArray<TempoSpanEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label, used in the
   * existing-spans summary so multiple tempo spans on one voice are
   * distinguishable.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: TempoSpanPopoverPatch) => void
}

const TEMPO_LABEL: Record<TempoSpanKind, string> = {
  accel: 'Accelerando (accel.)',
  rit: 'Ritardando (rit.)',
}

export default function TempoSpanPopover({
  open,
  anchorX,
  anchorY,
  existingTempoSpans,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: TempoSpanPopoverProps) {
  const [tempoKind, setTempoKind] = useState<TempoSpanKind>('accel')
  const [endEventId, setEndEventId] = useState<string>('')
  const [endTempoBpm, setEndTempoBpm] = useState<string>('') // string for the number input UX
  const [endTempoText, setEndTempoText] = useState<string>('')
  const [placement, setPlacement] = useState<'' | 'above' | 'below' | 'default'>('')
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  // Default end to the FIRST available subsequent event; the user
  // usually wants the tempo span to extend at least one note ahead.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTempoKind('accel')
      setEndEventId(availableEnds[0]?.eventId ?? '')
      setEndTempoBpm('')
      setEndTempoText('')
      setPlacement('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, availableEnds])

  // Derived effective end — same pattern as SlurPopover / HairpinPopover.
  // Clamp stale endEventId to the first available when the parent's
  // selection changes mid-open; preserve explicit-empty so Apply stays
  // disabled when the user picked the placeholder.
  const effectiveEndEventId =
    endEventId === ''
      ? ''
      : availableEnds.some((e) => e.eventId === endEventId)
        ? endEventId
        : availableEnds[0]?.eventId ?? ''

  // BPM parse: empty string OR a valid 30..240 integer. Invalid strings
  // disable submission via canSubmit so the user sees aria-invalid on
  // the field instead of silently emitting a bad op.
  const trimmedBpm = endTempoBpm.trim()
  const parsedBpm = trimmedBpm === '' ? undefined : Number(trimmedBpm)
  const bpmValid =
    trimmedBpm === '' ||
    (Number.isInteger(parsedBpm) &&
      parsedBpm !== undefined &&
      parsedBpm >= 30 &&
      parsedBpm <= 240)

  const canSubmit = effectiveEndEventId !== '' && bpmValid

  function submit() {
    if (!canSubmit) return
    const patch: Extract<TempoSpanPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      tempoKind,
      endEventId: effectiveEndEventId,
    }
    if (placement !== '') patch.placement = placement
    if (parsedBpm !== undefined) patch.endTempoBpm = parsedBpm
    const trimmedText = endTempoText.trim()
    if (trimmedText !== '') patch.endTempoText = trimmedText
    onPatch(patch)
    // Clear the per-span terminal fields so a rapid second Apply doesn't
    // silently duplicate them — kind + end stay sticky so a common
    // "accel. into this run, then accel. into the next" workflow re-uses
    // them.
    setEndTempoBpm('')
    setEndTempoText('')
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingTempoSpans.length > 0 ? 500 : 400}
      estimatedWidth={400}
      ariaLabel="Tempo span"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Tempo span (accelerando / ritardando)
      </div>

      {existingTempoSpans.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul
            className={styles.existingList}
            role="list"
            aria-label="Existing tempo spans"
          >
            {existingTempoSpans.map((t, idx) => {
              const summary = summarizeTempoSpan(t, eventPositions)
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
                      title="Remove this tempo span"
                      aria-label={`Remove tempo span ${summary}`}
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
          Add new tempo span (start = selected note)
        </div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Kind</span>
            <select
              ref={firstControlRef}
              className={styles.input}
              value={tempoKind}
              aria-label="Tempo span kind"
              onChange={(e) => setTempoKind(e.target.value as TempoSpanKind)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            >
              {TEMPO_SPAN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TEMPO_LABEL[k]}
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
            <span className={styles.fieldLabel}>Terminal BPM (optional, 30–240)</span>
            <input
              type="text"
              inputMode="numeric"
              className={styles.input}
              value={endTempoBpm}
              aria-label="Terminal BPM"
              aria-invalid={!bpmValid}
              placeholder="e.g. 60"
              onChange={(e) => setEndTempoBpm(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Terminal text (optional, max 40)</span>
            <input
              type="text"
              className={styles.input}
              value={endTempoText}
              aria-label="Terminal tempo text"
              maxLength={40}
              placeholder='e.g. "a tempo", "meno mosso"'
              onChange={(e) => setEndTempoText(e.target.value)}
            />
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
 * Human-readable one-line summary of a tempo span for the existing-list
 * row. Includes start→end positional info when positions is provided
 * so multiple spans on the same voice are distinguishable.
 */
function summarizeTempoSpan(
  t: Span & { kind: TempoSpanKind },
  positions?: ReadonlyMap<string, string>,
): string {
  const word = t.kind === 'accel' ? 'accel' : 'rit'
  const startPos = positions?.get(t.startEventId)
  const endPos = positions?.get(t.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  const terminal: string[] = []
  if (t.endTempoText !== undefined) terminal.push(t.endTempoText)
  if (t.endTempoBpm !== undefined) terminal.push(`♩=${t.endTempoBpm}`)
  const terminalTag = terminal.length > 0 ? ` → ${terminal.join(' ')}` : ''
  return `${word}${terminalTag}${positionTag}`
}
