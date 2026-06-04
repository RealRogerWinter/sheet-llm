'use client'

import type { Event, Ornament, TrillUpperPitch } from '@/lib/music/types'
import { isTrillFamilyOrnament } from '@/lib/music/ornaments'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './OrnamentMenuPopover.module.css'

export type OrnamentMenuPatch =
  | { kind: 'ornament'; ornament: Ornament }
  | { kind: 'trillUpperPitch'; trillUpperPitch?: TrillUpperPitch }
  | { kind: 'tremolo'; tremolo?: { slashes: 1 | 2 | 3 | 4 | 5; measured?: boolean } }
  | { kind: 'jazzInflection'; jazzInflection?: NonNullable<Event['jazzInflection']> }

export interface OrnamentMenuPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * Current marking state for the selected event. Drives active
   * highlighting + the seed value for the measured toggle / slash
   * radio so the popover reflects what's already set.
   */
  current: Pick<Event, 'ornament' | 'trillUpperPitch' | 'tremolo' | 'jazzInflection'>
  onClose: () => void
  /**
   * Called with a single patch describing one of the four groups.
   * Caller maps each patch to the corresponding op (setOrnament /
   * setTrillUpperPitch / setTremolo / setJazzInflection) since the
   * selection target lives at the call site, not here. The auto-clear
   * of orphan trillUpperPitch when leaving the trill family also
   * lives at the call site so it can read live store state (avoiding
   * closure-staleness — same pattern M3-PR-4 / M5-PR-3 established).
   *
   * Clear-all is the one path that emits multiple patches from a
   * single click — once per group.
   */
  onPatch: (patch: OrnamentMenuPatch) => void
}

type OrnamentGroup = {
  label: string
  options: Array<{ value: Ornament; label: string; title: string }>
}

const ORNAMENT_GROUPS: OrnamentGroup[] = [
  {
    label: 'Trill',
    options: [
      { value: 'trill', label: 'tr', title: 'Trill' },
      { value: 'pralltriller', label: '⅁', title: 'Pralltriller' },
    ],
  },
  {
    label: 'Mordent',
    options: [
      { value: 'mordent', label: '𝆗', title: 'Mordent' },
      { value: 'upper-mordent', label: '𝆗⌃', title: 'Upper mordent' },
      { value: 'lower-mordent', label: '𝆗⌄', title: 'Lower mordent' },
      { value: 'schneller', label: 'sn', title: 'Schneller' },
    ],
  },
  {
    label: 'Turn',
    options: [
      { value: 'turn', label: '∽', title: 'Turn' },
      { value: 'inverted-turn', label: '∾', title: 'Inverted turn' },
      { value: 'delayed-turn', label: 'd∽', title: 'Delayed turn' },
    ],
  },
  {
    label: 'Arpeggio',
    options: [
      { value: 'arpeggio-up', label: '↑arp', title: 'Arpeggio up' },
      { value: 'arpeggio-down', label: '↓arp', title: 'Arpeggio down' },
      { value: 'non-arpeggio', label: '|⃡', title: 'Non-arpeggio' },
    ],
  },
  {
    label: 'Other',
    options: [
      { value: 'slide', label: '/', title: 'Slide' },
      { value: 'grace', label: 'gr', title: 'Grace note' },
    ],
  },
]

const TRILL_PITCH_OPTIONS: Array<{ value: TrillUpperPitch; label: string; title: string }> = [
  { value: 'natural', label: '♮', title: 'Natural upper auxiliary' },
  { value: 'sharp', label: '♯', title: 'Sharp upper auxiliary' },
  { value: 'flat', label: '♭', title: 'Flat upper auxiliary' },
  { value: 'dblsharp', label: '𝄪', title: 'Double-sharp upper auxiliary' },
  { value: 'dblflat', label: '𝄫', title: 'Double-flat upper auxiliary' },
]

const JAZZ_OPTIONS: Array<{ value: NonNullable<Event['jazzInflection']>; label: string }> = [
  { value: 'fall', label: 'Fall ↘' },
  { value: 'doit', label: 'Doit ↗' },
  { value: 'scoop', label: 'Scoop ↗◯' },
  { value: 'plop', label: 'Plop ↘◯' },
  { value: 'ghost', label: 'Ghost (×)' },
]

const TREMOLO_SLASH_COUNTS: Array<1 | 2 | 3 | 4 | 5> = [1, 2, 3, 4, 5]

export default function OrnamentMenuPopover({
  open,
  anchorX,
  anchorY,
  current,
  onClose,
  onPatch,
}: OrnamentMenuPopoverProps) {
  const activeOrnament = current.ornament && current.ornament !== 'none' ? current.ornament : undefined
  const activeTrillPitch = current.trillUpperPitch
  const activeSlashes = current.tremolo?.slashes
  const measured = current.tremolo?.measured ?? true
  const activeJazz = current.jazzInflection
  const showTrillPitch = isTrillFamilyOrnament(activeOrnament)

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={showTrillPitch ? 420 : 380}
      estimatedWidth={360}
      ariaLabel="Ornament, tremolo, jazz inflection"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>Ornament · Tremolo · Jazz inflection</div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Ornament</div>
        <div className={styles.ornamentGrid} role="group" aria-label="Ornament">
          {ORNAMENT_GROUPS.map((group) => (
            <div key={group.label} className={styles.ornamentSubgroup}>
              <div className={styles.subgroupLabel}>{group.label}</div>
              <div className={styles.subgroupCells}>
                {group.options.map(({ value, label, title }) => {
                  const isActive = activeOrnament === value
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                      title={title}
                      aria-label={title}
                      aria-pressed={isActive}
                      onClick={() =>
                        onPatch({
                          kind: 'ornament',
                          ornament: isActive ? 'none' : value,
                        })
                      }
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        {showTrillPitch && (
          <div className={styles.trillPitchRow} role="group" aria-label="Trill upper pitch">
            <span className={styles.trillPitchLabel}>tr accidental</span>
            {TRILL_PITCH_OPTIONS.map(({ value, label, title }) => {
              const isActive = activeTrillPitch === value
              return (
                <button
                  key={value}
                  type="button"
                  className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                  title={title}
                  aria-label={title}
                  aria-pressed={isActive}
                  onClick={() => {
                    // Click active = clear, matching the ornament/
                    // tremolo/jazz toggle convention.
                    if (isActive) onPatch({ kind: 'trillUpperPitch' })
                    else onPatch({ kind: 'trillUpperPitch', trillUpperPitch: value })
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Tremolo (slashes through the stem)</div>
        <div className={styles.tremoloRow} role="group" aria-label="Tremolo">
          {TREMOLO_SLASH_COUNTS.map((n) => {
            const isActive = activeSlashes === n
            return (
              <button
                key={n}
                type="button"
                className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                aria-label={`${n} slash${n === 1 ? '' : 'es'}`}
                aria-pressed={isActive}
                onClick={() => {
                  // Click the active count again → clear; otherwise
                  // set, preserving the measured flag.
                  if (isActive) onPatch({ kind: 'tremolo' })
                  else onPatch({ kind: 'tremolo', tremolo: { slashes: n, measured } })
                }}
              >
                {'/'.repeat(n)}
              </button>
            )
          })}
          <label className={styles.measuredToggle}>
            <input
              type="checkbox"
              checked={measured}
              disabled={activeSlashes === undefined}
              onChange={(e) => {
                if (activeSlashes === undefined) return
                onPatch({
                  kind: 'tremolo',
                  tremolo: { slashes: activeSlashes, measured: e.target.checked },
                })
              }}
            />
            measured
          </label>
        </div>
      </div>

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Jazz inflection</div>
        <div className={styles.jazzRow} role="group" aria-label="Jazz inflection">
          {JAZZ_OPTIONS.map(({ value, label }) => {
            const isActive = activeJazz === value
            return (
              <button
                key={value}
                type="button"
                className={`${popoverStyles.cell} ${isActive ? popoverStyles.cellActive : ''}`}
                aria-label={value}
                aria-pressed={isActive}
                onClick={() => {
                  if (isActive) onPatch({ kind: 'jazzInflection' })
                  else onPatch({ kind: 'jazzInflection', jazzInflection: value })
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button
          type="button"
          className={styles.clearButton}
          onClick={() => {
            // Bulk clear all four groups.
            onPatch({ kind: 'ornament', ornament: 'none' })
            onPatch({ kind: 'trillUpperPitch' })
            onPatch({ kind: 'tremolo' })
            onPatch({ kind: 'jazzInflection' })
          }}
        >
          Clear all
        </button>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Done
        </button>
      </div>
    </Popover>
  )
}
