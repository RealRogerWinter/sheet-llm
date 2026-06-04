'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  Clef,
  Key,
  Marker,
  Meter,
  MetricModulation,
  MetricModulationNote,
} from '@/lib/music/types'
import { KeySchema, MetricModulationNoteSchema } from '@/lib/music/types'
import { isValidMeter } from '@/lib/music/meter'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './MarkerPopover.module.css'

/**
 * Patch shape emitted from the popover. Mirrors the M9-PR-1 op
 * surface:
 *   - insert: caller dispatches insertMarker against the live
 *     selection's measureIdx
 *   - remove: caller dispatches removeMarker by id
 */
export type MarkerPopoverPatch =
  | {
      kind: 'insert'
      key?: Key
      meter?: Meter
      tempo_bpm?: number
      tempo_text?: string
      // Per-staff clef changes (matches insertMarker op shape — the
      // 0|1 staffIdx is the literal-typed bound from ClefChangeSchema).
      clefs?: Array<{ staffIdx: 0 | 1; clef: Clef }>
      metricModulation?: MetricModulation
    }
  | { kind: 'remove'; id: string }

export interface MarkerPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Markers already attached to the selected measure. Each renders
   * as a small chip with a × button so the user can remove without
   * leaving the popover. Caller filters by measureIdx upstream.
   */
  existingMarkers: ReadonlyArray<Marker>
  /**
   * Number of staves on the score (1 = primary only; 2 = primary +
   * secondStaff). Drives whether the clef-change section shows one
   * or two per-staff pickers. Defaults to 1.
   *
   * The single-prefix-per-measure renderer (scoreToAbcWithMap.ts
   * markerToAbc) emits clef changes globally; multi-staff per-voice
   * routing is deferred (see scoreToAbcWithMap line 1273-1276). For
   * 2-staff scores the popover lets the user emit per-staff entries,
   * but visual rendering will currently apply to both lines.
   */
  staffCount?: 1 | 2
  onClose: () => void
  onPatch: (patch: MarkerPopoverPatch) => void
}

const KEY_OPTIONS = KeySchema.options
const MM_NOTE_OPTIONS = MetricModulationNoteSchema.options

const MM_NOTE_LABEL: Record<MetricModulationNote, string> = {
  half: '𝅗𝅥 half',
  'dotted-half': '𝅗𝅥. dotted half',
  quarter: '♩ quarter',
  'dotted-quarter': '♩. dotted quarter',
  eighth: '♪ eighth',
  'dotted-eighth': '♪. dotted eighth',
  sixteenth: '♬ sixteenth',
}

const MAX_TEMPO_TEXT = 40

export default function MarkerPopover({
  open,
  anchorX,
  anchorY,
  existingMarkers,
  staffCount = 1,
  onClose,
  onPatch,
}: MarkerPopoverProps) {
  // Form state. All fields independently optional; Apply emits only
  // the fields the user filled.
  const [tempoBpm, setTempoBpm] = useState('')
  const [tempoText, setTempoText] = useState('')
  const [meter, setMeter] = useState('')
  const [key, setKey] = useState<'' | Key>('')
  // Per-staff clef pickers. '' = no change; otherwise the new clef
  // for that staff. clefStaff0 always rendered; clefStaff1 only
  // rendered when staffCount === 2.
  const [clefStaff0, setClefStaff0] = useState<'' | Clef>('')
  const [clefStaff1, setClefStaff1] = useState<'' | Clef>('')
  const [mmFrom, setMmFrom] = useState<'' | MetricModulationNote>('')
  const [mmTo, setMmTo] = useState<'' | MetricModulationNote>('')
  const tempoBpmRef = useRef<HTMLInputElement | null>(null)

  // Re-seed on closed→open transition (M5-PR-3 wasOpen pattern).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTempoBpm('')
      setTempoText('')
      setMeter('')
      setKey('')
      setClefStaff0('')
      setClefStaff1('')
      setMmFrom('')
      setMmTo('')
      queueMicrotask(() => tempoBpmRef.current?.focus())
    }
    wasOpen.current = open
  }, [open])

  function computePatch(): MarkerPopoverPatch | undefined {
    const patch: Extract<MarkerPopoverPatch, { kind: 'insert' }> = { kind: 'insert' }
    // Parse tempo_bpm if provided + in range.
    if (tempoBpm.trim() !== '') {
      const n = Number(tempoBpm)
      if (Number.isFinite(n) && n >= 30 && n <= 240) {
        patch.tempo_bpm = Math.round(n)
      }
    }
    if (tempoText.trim() !== '') patch.tempo_text = tempoText.trim()
    if (meter.trim() !== '' && isValidMeter(meter.trim())) {
      patch.meter = meter.trim() as Meter
    }
    if (key !== '') patch.key = key
    // Clefs: collect filled per-staff entries. Only emit the `clefs`
    // array when at least one staff has a pick; the staff1 picker is
    // only consulted when staffCount === 2 (the form section is
    // hidden in single-staff scores).
    const clefs: Array<{ staffIdx: 0 | 1; clef: Clef }> = []
    if (clefStaff0 !== '') clefs.push({ staffIdx: 0, clef: clefStaff0 })
    if (staffCount === 2 && clefStaff1 !== '') {
      clefs.push({ staffIdx: 1, clef: clefStaff1 })
    }
    if (clefs.length > 0) patch.clefs = clefs
    // Metric modulation: only emit when BOTH from and to are picked.
    if (mmFrom !== '' && mmTo !== '') {
      patch.metricModulation = { fromNote: mmFrom, toNote: mmTo }
    }
    const hasAnyField =
      patch.tempo_bpm !== undefined ||
      patch.tempo_text !== undefined ||
      patch.meter !== undefined ||
      patch.key !== undefined ||
      patch.clefs !== undefined ||
      patch.metricModulation !== undefined
    return hasAnyField ? patch : undefined
  }

  const previewPatch = computePatch()
  const canSubmit = previewPatch !== undefined

  function submit() {
    const patch = computePatch()
    if (patch === undefined) return
    onPatch(patch)
    // Clear the per-marker text inputs so a subsequent Apply
    // doesn't duplicate. Also clear metric-modulation + clefs if
    // they just fired — leaving them sticky would silently re-emit
    // the same change on the next marker. Key + meter STAY sticky
    // because those genuinely benefit from being shared across
    // rapid bar-to-bar marker drops.
    setTempoBpm('')
    setTempoText('')
    if (patch.kind === 'insert' && patch.metricModulation !== undefined) {
      setMmFrom('')
      setMmTo('')
    }
    if (patch.kind === 'insert' && patch.clefs !== undefined) {
      setClefStaff0('')
      setClefStaff1('')
    }
    queueMicrotask(() => tempoBpmRef.current?.focus())
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={
        (existingMarkers.length > 0 ? 540 : 460) + (staffCount === 2 ? 110 : 70)
      }
      estimatedWidth={400}
      ariaLabel="Marker"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Marker</div>

      {existingMarkers.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>On this measure</div>
          <ul className={styles.existingList} role="list" aria-label="Existing markers">
            {existingMarkers.map((m, idx) => (
              <li
                key={
                  m.id ??
                  `__noid:${idx}:${m.measureIdx}`
                }
                className={styles.existingRow}
              >
                <span className={styles.existingSummary} title={summarizeMarker(m)}>
                  {summarizeMarker(m)}
                </span>
                {m.id !== undefined && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    title="Remove this marker"
                    aria-label={`Remove marker ${summarizeMarker(m)}`}
                    onClick={() => onPatch({ kind: 'remove', id: m.id! })}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Add new marker</div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Tempo (bpm)</span>
            <input
              ref={tempoBpmRef}
              type="number"
              className={styles.input}
              value={tempoBpm}
              min={30}
              max={240}
              placeholder="e.g. 120"
              aria-label="Tempo bpm"
              onChange={(e) => setTempoBpm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Tempo text</span>
            <input
              type="text"
              className={styles.input}
              value={tempoText}
              maxLength={MAX_TEMPO_TEXT}
              placeholder='e.g. "Allegro"'
              aria-label="Tempo text"
              onChange={(e) => setTempoText(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Meter</span>
            <input
              type="text"
              className={styles.input}
              value={meter}
              placeholder="e.g. 3/4, 6/8"
              aria-label="Meter"
              aria-invalid={meter.trim() !== '' && !isValidMeter(meter.trim())}
              onChange={(e) => setMeter(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Key</span>
            <select
              className={styles.input}
              value={key}
              aria-label="Key"
              onChange={(e) => setKey(e.target.value as '' | Key)}
            >
              <option value="">— (no key change)</option>
              {KEY_OPTIONS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Clef change</div>
        <div className={styles.clefRows}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {staffCount === 2 ? 'Staff 1 (primary)' : 'New clef'}
            </span>
            <select
              className={styles.input}
              value={clefStaff0}
              aria-label="Clef change staff 1"
              onChange={(e) => setClefStaff0(e.target.value as '' | Clef)}
            >
              <option value="">— (no change)</option>
              <option value="treble">treble</option>
              <option value="bass">bass</option>
            </select>
          </label>
          {staffCount === 2 && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Staff 2 (secondStaff)</span>
              <select
                className={styles.input}
                value={clefStaff1}
                aria-label="Clef change staff 2"
                onChange={(e) => setClefStaff1(e.target.value as '' | Clef)}
              >
                <option value="">— (no change)</option>
                <option value="treble">treble</option>
                <option value="bass">bass</option>
              </select>
            </label>
          )}
        </div>
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Metric modulation</div>
        <div className={styles.mmRow}>
          <label className={styles.mmField}>
            <span className={styles.fieldLabel}>From</span>
            <select
              className={styles.input}
              value={mmFrom}
              aria-label="Metric modulation from-note"
              // Mark the empty half invalid when its partner is set —
              // metric modulation requires BOTH or NEITHER. Without
              // this, the user would Apply and the form would silently
              // drop the half-state mm.
              aria-invalid={mmFrom === '' && mmTo !== ''}
              onChange={(e) => setMmFrom(e.target.value as '' | MetricModulationNote)}
            >
              <option value="">—</option>
              {MM_NOTE_OPTIONS.map((n) => (
                <option key={n} value={n}>{MM_NOTE_LABEL[n]}</option>
              ))}
            </select>
          </label>
          <span className={styles.mmEquals} aria-hidden="true">=</span>
          <label className={styles.mmField}>
            <span className={styles.fieldLabel}>To</span>
            <select
              className={styles.input}
              value={mmTo}
              aria-label="Metric modulation to-note"
              aria-invalid={mmTo === '' && mmFrom !== ''}
              onChange={(e) => setMmTo(e.target.value as '' | MetricModulationNote)}
            >
              <option value="">—</option>
              {MM_NOTE_OPTIONS.map((n) => (
                <option key={n} value={n}>{MM_NOTE_LABEL[n]}</option>
              ))}
            </select>
          </label>
        </div>
        {(mmFrom === '') !== (mmTo === '') && (
          <div className={styles.mmHint}>
            Metric modulation needs BOTH from-note and to-note. The
            half-state is ignored.
          </div>
        )}
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

/** Human-readable one-line summary of a Marker for the existing-list row. */
function summarizeMarker(m: Marker): string {
  const parts: string[] = []
  if (m.tempo_bpm !== undefined && m.tempo_text !== undefined) {
    parts.push(`${m.tempo_text} (${m.tempo_bpm} bpm)`)
  } else if (m.tempo_text !== undefined) {
    parts.push(m.tempo_text)
  } else if (m.tempo_bpm !== undefined) {
    parts.push(`${m.tempo_bpm} bpm`)
  }
  if (m.meter !== undefined) parts.push(`meter ${m.meter}`)
  if (m.key !== undefined) parts.push(`key ${m.key}`)
  if (m.metricModulation !== undefined) {
    parts.push(`${m.metricModulation.fromNote} = ${m.metricModulation.toNote}`)
  }
  if (m.clefs && m.clefs.length > 0) {
    // For 2-staff scores the user may set per-staff clefs; print
    // each so they can tell which side will flip.
    const clefParts = m.clefs.map((c) =>
      m.clefs!.length === 1
        ? `clef → ${c.clef}`
        : `staff ${c.staffIdx + 1} → ${c.clef}`,
    )
    parts.push(clefParts.join(', '))
  }
  return parts.length > 0 ? parts.join(', ') : 'marker'
}
