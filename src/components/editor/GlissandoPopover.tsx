'use client'

import { useEffect, useRef, useState } from 'react'
import type { Span } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './GlissandoPopover.module.css'
import type { HairpinEndOption } from './HairpinPopover'

/**
 * Patch shape emitted from the GlissandoPopover (M20-PR-4). Mirrors
 * the M20-PR-1 op surface — caller dispatches against the live
 * selection (start event) and the chosen end event.
 *
 * Glissandos are a single-kind family (no kind axis); the decorators
 * (glissStyle + glissText) shape the visual rendering at the renderer
 * level.
 */
export type GlissandoPopoverPatch =
  | {
      kind: 'insert'
      endEventId: string
      placement?: 'above' | 'below' | 'default'
      glissStyle?: 'straight' | 'wavy'
      glissText?: boolean
    }
  | { kind: 'remove'; id: string }

export type GlissandoEndOption = HairpinEndOption

export interface GlissandoPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Glissandos already attached to the same (staff, voice). Each
   * renders as a small chip with a × button so the user can remove
   * without leaving the popover.
   */
  existingGlissandos: ReadonlyArray<Span & { kind: 'glissando' }>
  /**
   * Subsequent events on the same voice available as the span's end
   * target.
   */
  availableEnds: ReadonlyArray<GlissandoEndOption>
  /**
   * Optional eventId → "m<N> b<M>" position label, used in the
   * existing-spans summary.
   */
  eventPositions?: ReadonlyMap<string, string>
  onClose: () => void
  onPatch: (patch: GlissandoPopoverPatch) => void
}

export default function GlissandoPopover({
  open,
  anchorX,
  anchorY,
  existingGlissandos,
  availableEnds,
  eventPositions,
  onClose,
  onPatch,
}: GlissandoPopoverProps) {
  const [endEventId, setEndEventId] = useState<string>('')
  const [glissStyle, setGlissStyle] = useState<'' | 'straight' | 'wavy'>('')
  const [glissText, setGlissText] = useState<boolean>(false)
  const [placement, setPlacement] = useState<'' | 'above' | 'below' | 'default'>('')
  const firstControlRef = useRef<HTMLSelectElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  // Default end to the FIRST available subsequent event — glissandos
  // typically slide to the next note.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setEndEventId(availableEnds[0]?.eventId ?? '')
      setGlissStyle('')
      setGlissText(false)
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
    const patch: Extract<GlissandoPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      endEventId: effectiveEndEventId,
    }
    if (placement !== '') patch.placement = placement
    if (glissStyle !== '') patch.glissStyle = glissStyle
    if (glissText) patch.glissText = true
    onPatch(patch)
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingGlissandos.length > 0 ? 480 : 380}
      estimatedWidth={400}
      ariaLabel="Glissando"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Glissando (pitch slide)</div>

      {existingGlissandos.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this voice</div>
          <ul
            className={styles.existingList}
            role="list"
            aria-label="Existing glissandos"
          >
            {existingGlissandos.map((g, idx) => {
              const summary = summarizeGlissando(g, eventPositions)
              const id = g.id
              return (
                <li
                  key={id ?? `__noid:${idx}:${g.startEventId}:${g.endEventId}`}
                  className={styles.existingRow}
                >
                  <span className={styles.existingSummary} title={summary}>
                    {summary}
                  </span>
                  {id !== undefined && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      title="Remove this glissando"
                      aria-label={`Remove glissando ${summary}`}
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
          Add new glissando (start = selected note)
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
            <span className={styles.fieldLabel}>Style (optional)</span>
            <select
              className={styles.input}
              value={glissStyle}
              aria-label="Glissando style"
              onChange={(e) =>
                setGlissStyle(e.target.value as '' | 'straight' | 'wavy')
              }
            >
              <option value="">— (default: straight)</option>
              <option value="straight">straight</option>
              <option value="wavy">wavy (portamento)</option>
            </select>
          </label>
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={glissText}
              aria-label="Show 'gliss.' text label"
              onChange={(e) => setGlissText(e.target.checked)}
            />
            <span>Show &ldquo;gliss.&rdquo; text label</span>
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

/** Human-readable one-line summary for the existing-list row. */
function summarizeGlissando(
  g: Span & { kind: 'glissando' },
  positions?: ReadonlyMap<string, string>,
): string {
  const startPos = positions?.get(g.startEventId)
  const endPos = positions?.get(g.endEventId)
  const positionTag = startPos && endPos ? ` (${startPos} → ${endPos})` : ''
  const styleTag = g.glissStyle === 'wavy' ? ' wavy' : ''
  const textTag = g.glissText ? ' "gliss."' : ''
  return `glissando${styleTag}${textTag}${positionTag}`
}

