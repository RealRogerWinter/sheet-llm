'use client'

import { useEffect, useRef, useState } from 'react'
import type { JumpKind, JumpMarker, SegnoMarker, CodaMarker } from '@/lib/music/types'
import { JUMP_KINDS } from '@/lib/music/spans'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './JumpMarkerPopover.module.css'

/**
 * Patch shape emitted from JumpMarkerPopover. The popover never mutates
 * score state directly — the caller resolves each intent against the
 * snapshotted measure target so mid-popover selection changes don't
 * corrupt the patch (same pattern as M16-PR-4 BarlinePopover and
 * M17-PR-4 VoltaPopover).
 *
 * Two intent shapes:
 *   - 'insert' — caller dispatches insertJumpMarker.
 *   - 'remove' — caller dispatches removeJumpMarker.
 *
 * NOTE: no `update` patch in v1 — users remove + re-insert to edit a
 * jumpMarker's kind/measure/refs. The popover's existing-list × button
 * only emits `remove`. updateJumpMarker is wired through the LLM
 * (M18-PR-4) + the op layer (M18-PR-1) but not yet surfaced in this UI.
 */
export type JumpMarkerPopoverPatch =
  | {
      kind: 'insert'
      measureIdx: number
      side: 'start' | 'end'
      jumpKind: JumpKind
      segnoRef?: string
      codaRef?: string
      toCodaRef?: string
    }
  | { kind: 'remove'; id: string }

export interface JumpMarkerPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Measure number the popover anchors to (1-indexed for display).
   * Used as the DEFAULT measure for new jumpMarkers — the anchor
   * matches the user's current selection at open time.
   */
  measureIdx: number
  /**
   * JumpMarkers already attached to the score. Each renders as a
   * small chip with a × button so the user can remove without
   * leaving the popover.
   */
  existingJumpMarkers: ReadonlyArray<JumpMarker>
  /**
   * Segno landmarks available in the score (for D.S.* segnoRef
   * selection). When empty, D.S.* kinds will produce a warning
   * (the segnoRef is required by validateCrossRefs).
   */
  segnoMarkers: ReadonlyArray<SegnoMarker>
  /**
   * Coda landmarks available in the score (for *.al-Coda codaRef
   * selection). When empty, *.al-Coda kinds still emit but expand()
   * will warn at playback resolution time.
   */
  codaMarkers: ReadonlyArray<CodaMarker>
  /** Total measures — used to clamp the measure input. */
  measureCount: number
  onClose: () => void
  onPatch: (patch: JumpMarkerPopoverPatch) => void
}

/** Predicates from the schema-level helpers (avoid re-importing isJump…). */
function kindRequiresSegno(k: JumpKind): boolean {
  return k === 'D.S.' || k === 'D.S. al Coda' || k === 'D.S. al Fine'
}
function kindUsesCoda(k: JumpKind): boolean {
  return k === 'D.C. al Coda' || k === 'D.S. al Coda'
}

export default function JumpMarkerPopover({
  open,
  anchorX,
  anchorY,
  measureIdx,
  existingJumpMarkers,
  segnoMarkers,
  codaMarkers,
  measureCount,
  onClose,
  onPatch,
}: JumpMarkerPopoverProps) {
  const firstControlRef = useRef<HTMLSelectElement | null>(null)
  // Default to the most common case: bare D.C. at the end of the
  // selected measure. Sticky kind across Applies (a user adding a
  // To Coda then a D.S. al Coda often wants the second pre-filled
  // similarly), but defaults reset cleanly on each close→open.
  const [pendingKind, setPendingKind] = useState<JumpKind>('D.C.')
  const [pendingMeasure, setPendingMeasure] = useState<string>(String(measureIdx + 1))
  const [pendingSide, setPendingSide] = useState<'start' | 'end'>('end')
  const [pendingSegnoRef, setPendingSegnoRef] = useState<string>('')
  const [pendingCodaRef, setPendingCodaRef] = useState<string>('')
  const [pendingToCodaRef, setPendingToCodaRef] = useState<string>('')

  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Re-seed on close→open transition (wasOpen pattern).
      setPendingKind('D.C.')
      setPendingMeasure(String(measureIdx + 1))
      setPendingSide('end')
      setPendingSegnoRef('')
      setPendingCodaRef('')
      setPendingToCodaRef('')
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, measureIdx])

  const measureN = Number(pendingMeasure.trim())
  const measureValid =
    Number.isInteger(measureN) && measureN >= 1 && measureN <= measureCount

  const requiresSegno = kindRequiresSegno(pendingKind)
  const usesCoda = kindUsesCoda(pendingKind)
  // D.S.* WITHOUT a chosen segnoRef is a hard reject (validateCrossRefs
  // enforces). Block submit.
  const segnoValid = !requiresSegno || pendingSegnoRef.length > 0
  const canSubmit = measureValid && segnoValid

  function submit() {
    if (!canSubmit) return
    const patch: Extract<JumpMarkerPopoverPatch, { kind: 'insert' }> = {
      kind: 'insert',
      measureIdx: measureN - 1,
      side: pendingSide,
      jumpKind: pendingKind,
    }
    if (requiresSegno && pendingSegnoRef) patch.segnoRef = pendingSegnoRef
    if (usesCoda && pendingCodaRef) patch.codaRef = pendingCodaRef
    if (usesCoda && pendingToCodaRef) patch.toCodaRef = pendingToCodaRef
    onPatch(patch)
    // Sticky kind + measure (user often emits a To Coda then the
    // matching *.al-Coda); clear ref selections so they re-enter.
    setPendingSegnoRef('')
    setPendingCodaRef('')
    setPendingToCodaRef('')
  }

  // Filter existing jumpMarkers + segno/coda landmarks to those at
  // the anchor measure for a focused list. The toolbar active-state
  // lights up for any landmark family at the measure, so the popover
  // surfaces all three (jumps + Segnos + Codas) so a user clicking
  // an active toolbar button always sees something. Segno/Coda
  // landmarks render as read-only rows today — edit ops for them
  // ship in a future PR.
  const nearbyJumps = existingJumpMarkers.filter((j) => j.measureIdx === measureIdx)
  const nearbySegnos = segnoMarkers.filter((s) => s.measureIdx === measureIdx)
  const nearbyCodas = codaMarkers.filter((c) => c.measureIdx === measureIdx)
  const hasAnyNearby =
    nearbyJumps.length > 0 || nearbySegnos.length > 0 || nearbyCodas.length > 0

  // Available To Coda jumpMarkers for the toCodaRef selector (only
  // 'To Coda' kind entries; other jumpMarker kinds aren't valid hop
  // targets — toCodaRef MUST point at a 'To Coda' entry per the
  // M18-PR-3 expand() semantics).
  const toCodaCandidates = existingJumpMarkers.filter((j) => j.kind === 'To Coda')

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingJumpMarkers.length > 0 ? 540 : 460}
      estimatedWidth={460}
      ariaLabel="Jump markers"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Jump markers — measure {measureIdx + 1}
      </div>

      {hasAnyNearby && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>
            Anchored to this measure
          </div>
          <ul className={styles.existingList} role="list" aria-label="Existing jumpMarkers">
            {nearbyJumps.map((j) => (
              <li key={j.id} className={styles.existingRow}>
                <span className={styles.existingSummary} title={summarizeJump(j)}>
                  {summarizeJump(j)}
                </span>
                <button
                  type="button"
                  className={styles.removeButton}
                  title="Remove this jumpMarker"
                  aria-label={`Remove jumpMarker ${j.kind}`}
                  onClick={() => onPatch({ kind: 'remove', id: j.id })}
                >
                  ×
                </button>
              </li>
            ))}
            {nearbySegnos.map((s) => (
              <li key={s.id} className={styles.existingRow}>
                <span className={styles.existingSummary} title={`Segno landmark (${s.side})`}>
                  {`Segno (${s.side === 'end' ? 'end' : 'start'}) — read-only`}
                </span>
              </li>
            ))}
            {nearbyCodas.map((c) => (
              <li key={c.id} className={styles.existingRow}>
                <span className={styles.existingSummary} title={`Coda landmark (${c.side})`}>
                  {`Coda (${c.side === 'end' ? 'end' : 'start'}) — read-only`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Add new jump marker</div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Kind</span>
            <select
              ref={firstControlRef}
              className={styles.input}
              value={pendingKind}
              aria-label="Jump kind"
              onChange={(e) => setPendingKind(e.target.value as JumpKind)}
            >
              {JUMP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Measure</span>
            <input
              type="text"
              inputMode="numeric"
              className={styles.input}
              value={pendingMeasure}
              aria-label="Measure (1-indexed)"
              aria-invalid={!measureValid}
              onChange={(e) => setPendingMeasure(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Side</span>
            <select
              className={styles.input}
              value={pendingSide}
              aria-label="Side"
              onChange={(e) => setPendingSide(e.target.value as 'start' | 'end')}
            >
              <option value="end">end (most common)</option>
              <option value="start">start</option>
            </select>
          </label>
          {requiresSegno && (
            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>Segno (required for D.S.*)</span>
              <select
                className={styles.input}
                value={pendingSegnoRef}
                aria-label="Segno reference"
                aria-invalid={!segnoValid}
                onChange={(e) => setPendingSegnoRef(e.target.value)}
              >
                <option value="">— pick a Segno —</option>
                {segnoMarkers.map((s) => (
                  <option key={s.id} value={s.id}>
                    Segno @ m{s.measureIdx + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
          {usesCoda && (
            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>Coda (target of al-Coda hop)</span>
              <select
                className={styles.input}
                value={pendingCodaRef}
                aria-label="Coda reference"
                onChange={(e) => setPendingCodaRef(e.target.value)}
              >
                <option value="">— (optional)</option>
                {codaMarkers.map((c) => (
                  <option key={c.id} value={c.id}>
                    Coda @ m{c.measureIdx + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
          {usesCoda && toCodaCandidates.length > 0 && (
            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>
                To Coda gate (multi-coda; optional)
              </span>
              <select
                className={styles.input}
                value={pendingToCodaRef}
                aria-label="To Coda gate"
                onChange={(e) => setPendingToCodaRef(e.target.value)}
              >
                <option value="">— any To Coda fires —</option>
                {toCodaCandidates.map((j) => (
                  <option key={j.id} value={j.id}>
                    To Coda @ m{j.measureIdx + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {requiresSegno && segnoMarkers.length === 0 && (
          <div className={styles.warning}>
            No Segno landmarks in this score. D.S.* requires a Segno
            target — author a Segno via the AI (&ldquo;add a Segno at
            bar 4&rdquo;) before placing this jumpMarker.
          </div>
        )}
        {usesCoda && codaMarkers.length === 0 && (
          <div className={styles.warning}>
            No Coda landmarks in this score. *.al-Coda will arm but
            won&apos;t reach a Coda — author a Coda via the AI
            (&ldquo;add a Coda at bar 12&rdquo;) to complete the hop
            target.
          </div>
        )}
        {usesCoda && toCodaCandidates.length === 0 && (
          <div className={styles.hint}>
            No To Coda jumpMarkers yet. The al-Coda will arm but have
            no gating point — author a To Coda jumpMarker on the
            earlier measure where the hop should fire.
          </div>
        )}
        <div className={styles.hint}>
          Jump markers fire at most once per playback. Fine acts only
          after a *.al-Fine has armed it; To Coda acts only after a
          *.al-Coda has armed it (classical convention).
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

function summarizeJump(j: JumpMarker): string {
  const where = `m${j.measureIdx + 1} ${j.side === 'end' ? '(end)' : '(start)'}`
  const refs: string[] = []
  if (j.segnoRef) refs.push('→ Segno')
  if (j.codaRef) refs.push('→ Coda')
  if (j.toCodaRef) refs.push('→ To Coda')
  return refs.length > 0 ? `${j.kind} ${where} ${refs.join(' ')}` : `${j.kind} ${where}`
}
