'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  buildChord,
  CHORD_QUALITIES,
  ChordBuildError,
  type ChordQualityId,
} from '@/lib/music/chords'
import type { Accidental, Key, Pitch, Step } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './ChordPalette.module.css'

/** 12 chromatic roots, sharp-spelled by default. */
const ROOTS: Array<{ step: Step; accidental?: Accidental; label: string }> = [
  { step: 'C', label: 'C' },
  { step: 'C', accidental: 'sharp', label: 'C♯' },
  { step: 'D', label: 'D' },
  { step: 'D', accidental: 'sharp', label: 'D♯' },
  { step: 'E', label: 'E' },
  { step: 'F', label: 'F' },
  { step: 'F', accidental: 'sharp', label: 'F♯' },
  { step: 'G', label: 'G' },
  { step: 'G', accidental: 'sharp', label: 'G♯' },
  { step: 'A', label: 'A' },
  { step: 'A', accidental: 'sharp', label: 'A♯' },
  { step: 'B', label: 'B' },
]

function rootIndex(root: Pitch | undefined): number {
  if (!root || root.step === 'rest') return 0
  const targetAcc = root.accidental === 'sharp' ? 'sharp' : undefined
  return ROOTS.findIndex(
    (r) => r.step === root.step && (r.accidental ?? undefined) === targetAcc,
  ) ?? 0
}

function pitchLabel(p: Pitch): string {
  if (p.step === 'rest') return 'rest'
  const acc = p.accidental === 'sharp' ? '♯'
    : p.accidental === 'flat' ? '♭'
    : p.accidental === 'natural' ? '♮'
    : ''
  return `${p.step}${acc}${p.octave}`
}

export interface ChordPaletteProps {
  open: boolean
  /** Viewport coords for the anchor (typically the trigger button's center-bottom). */
  anchorX: number
  anchorY: number
  /** Optional seed root; defaults to C4. */
  initialRoot?: Pitch
  /** Optional seed quality; defaults to 'maj'. */
  initialQuality?: ChordQualityId
  /** Current key signature — drives chord spelling. */
  scoreKey: Key
  onClose: () => void
  /** Called with the built pitch list when the user clicks Insert. */
  onSubmit: (pitches: Pitch[]) => void
  /** Label for the action button; defaults to "Insert". */
  submitLabel?: string
}

export default function ChordPalette({
  open,
  anchorX,
  anchorY,
  initialRoot,
  initialQuality = 'maj',
  scoreKey,
  onClose,
  onSubmit,
  submitLabel = 'Insert',
}: ChordPaletteProps) {
  const seedOctave = initialRoot?.octave ?? 4
  const [rootIdx, setRootIdx] = useState(() => rootIndex(initialRoot))
  const [quality, setQuality] = useState<ChordQualityId>(initialQuality)

  // Reset state each time the palette opens so a fresh anchor gets
  // a fresh selection.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open: fresh anchor → fresh selection
      setRootIdx(rootIndex(initialRoot))
      setQuality(initialQuality)
    }
  }, [open, initialRoot, initialQuality])

  const root = useMemo<Pitch>(() => {
    const r = ROOTS[rootIdx]
    const pitch: Pitch = { step: r.step, octave: seedOctave }
    if (r.accidental) pitch.accidental = r.accidental
    return pitch
  }, [rootIdx, seedOctave])

  const { pitches, error } = useMemo(() => {
    try {
      return { pitches: buildChord(root, quality, scoreKey), error: null }
    } catch (e) {
      const msg = e instanceof ChordBuildError ? e.message : 'Could not build chord'
      return { pitches: [] as Pitch[], error: msg }
    }
  }, [root, quality, scoreKey])

  const qualityLabel = CHORD_QUALITIES.find((q) => q.id === quality)?.label ?? quality
  const previewName = `${ROOTS[rootIdx].label} ${qualityLabel}`

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={220}
      estimatedWidth={360}
      ariaLabel="Chord palette"
      onClose={onClose}
      className={styles.palette}
    >
      <div className={styles.header}>
        <span className={styles.previewName}>{previewName}</span>
        <span className={styles.previewPitches}>
          {pitches.length > 0
            ? pitches.map(pitchLabel).join(' · ')
            : error ?? '—'}
        </span>
      </div>

      <div className={popoverStyles.section}>
        <span className={popoverStyles.sectionLabel}>Root</span>
        <div className={styles.rootGrid}>
          {ROOTS.map((r, i) => (
            <button
              key={r.label}
              type="button"
              className={`${popoverStyles.cell} ${styles.cellLg} ${i === rootIdx ? popoverStyles.cellActive : ''}`}
              onClick={() => setRootIdx(i)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={popoverStyles.section}>
        <span className={popoverStyles.sectionLabel}>Quality</span>
        <div className={styles.qualityGrid}>
          {CHORD_QUALITIES.map((q) => (
            <button
              key={q.id}
              type="button"
              className={`${popoverStyles.cell} ${styles.cellLg} ${quality === q.id ? popoverStyles.cellActive : ''}`}
              onClick={() => setQuality(q.id)}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      <div className={popoverStyles.footer}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={popoverStyles.primary}
          disabled={pitches.length === 0}
          onClick={() => {
            if (pitches.length > 0) {
              onSubmit(pitches)
              onClose()
            }
          }}
        >
          {submitLabel}
        </button>
      </div>
    </Popover>
  )
}
