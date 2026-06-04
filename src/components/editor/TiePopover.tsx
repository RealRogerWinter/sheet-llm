'use client'

import { useEffect, useRef } from 'react'
import type { Pitch } from '@/lib/music/types'
import { isPitchTiedToNext } from '@/lib/music/pitchTies'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './TiePopover.module.css'

/**
 * Patch shape emitted from the TiePopover. The popover never mutates
 * score state directly — the caller resolves each intent against the
 * LIVE store (so closure-stale selection / event state at submit time
 * doesn't silently corrupt the patched score). Mirrors the
 * HairpinPopover / SlurPopover precedent.
 *
 * Three intent shapes:
 *   - 'event': toggle the whole-event tied_to_next (chord-wide tie).
 *     Caller dispatches `toggleTie` if current ≠ desired; the
 *     popover-side state has already computed desired from the live
 *     event but the caller may re-read for safety.
 *   - 'pitch-tie': set per-pitch tied_to_next on a specific chord
 *     tone. Caller dispatches setPitchTie with the desired bool.
 *     `false` is a documented override that releases one tone from
 *     an event-wide tie (pitchTies.ts:24-26 precedence).
 *   - 'lv': set per-pitch laissez vibrer. Rejects on rest pitches.
 *   - 'enharmonic': set per-pitch enharmonicTie escape hatch.
 */
export type TiePopoverPatch =
  | { kind: 'event'; tied_to_next: boolean }
  | { kind: 'pitch-tie'; pitchIdx: number; tied_to_next: boolean }
  | { kind: 'lv'; pitchIdx: number; lv: boolean }
  | { kind: 'enharmonic'; pitchIdx: number; enharmonicTie: boolean }

export interface TiePopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * The selected event. Used to render the per-pitch rows with
   * current tied / lv / enharmonicTie state. Caller passes the
   * derived event so toggles can show real state — closures are not
   * relied on at submit time (patch shape is user-intent only).
   */
  pitches: ReadonlyArray<Pitch>
  /**
   * Event-wide tied_to_next flag. Drives the "Tie chord into next
   * event" master toggle.
   */
  eventTiedToNext: boolean
  onClose: () => void
  onPatch: (patch: TiePopoverPatch) => void
}

function pitchToLabel(p: Pitch): string {
  if (p.step === 'rest') return 'rest'
  const acc =
    p.accidental === 'sharp'
      ? '♯'
      : p.accidental === 'flat'
        ? '♭'
        : p.accidental === 'natural'
          ? '♮'
          : p.accidental === 'dblsharp'
            ? '𝄪'
            : p.accidental === 'dblflat'
              ? '𝄫'
              : ''
  return `${p.step}${acc}${p.octave}`
}

export default function TiePopover({
  open,
  anchorX,
  anchorY,
  pitches,
  eventTiedToNext,
  onClose,
  onPatch,
}: TiePopoverProps) {
  const firstControlRef = useRef<HTMLInputElement | null>(null)

  // Focus the first interactive control on closed→open transition.
  // Mirrors the wasOpen-ref idiom from SlurPopover so re-renders of
  // an already-open popover don't steal focus from a user's drag-tap.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open])

  const isChord = pitches.length > 1
  const allRests = pitches.every((p) => p.step === 'rest')

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={isChord ? 280 + 56 * pitches.length : 240}
      estimatedWidth={380}
      ariaLabel="Tie"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Tie ({isChord ? 'chord' : 'single pitch'} — tied_to_next / lv / enharmonic)
      </div>

      {/*
        Event-wide toggle: ties EVERY pitch in the event into the
        corresponding pitch of the next event. Convenient for the
        common "tie this chord" case. Per-pitch overrides below WIN
        over the event-wide setting (pitchTies.ts precedence rules).
      */}
      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Event-wide</div>
        <label className={styles.row}>
          <input
            ref={firstControlRef}
            type="checkbox"
            checked={eventTiedToNext}
            disabled={allRests}
            aria-label="Tie event to next"
            onChange={(e) => onPatch({ kind: 'event', tied_to_next: e.target.checked })}
          />
          <span className={styles.rowLabel}>
            Tie {isChord ? 'chord' : 'note'} into next event
          </span>
        </label>
      </div>

      {/*
        Per-pitch rows. Always rendered (even for single-pitch events)
        so users can set lv / enharmonicTie on the one pitch without
        relying on the event-wide toggle. For a chord, this is where
        partial ties (one chord tone tied, others not) get expressed.
      */}
      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Per pitch</div>
        <ul className={styles.pitchList} role="list" aria-label="Per-pitch tie controls">
          {pitches.map((p, i) => {
            const label = pitchToLabel(p)
            const isRest = p.step === 'rest'
            // Show derived tied state via isPitchTiedToNext so the
            // checkbox reflects the actual rendered tie (per-pitch
            // overrides event-wide). The "indeterminate" case
            // (per-pitch absent + event-wide true) shows as checked
            // but the patch dispatched on toggle is per-pitch.
            const tied = isPitchTiedToNext(p, { tied_to_next: eventTiedToNext })
            const lv = p.lv === true
            const enharmonic = p.enharmonicTie === true
            return (
              <li key={i} className={styles.pitchRow}>
                <span className={styles.pitchLabel}>{label}</span>
                <label
                  className={styles.checkboxCell}
                  title="Tie this pitch into the corresponding pitch in the next event"
                >
                  <input
                    type="checkbox"
                    checked={tied}
                    disabled={isRest}
                    aria-label={`Tie pitch ${i + 1} (${label})`}
                    onChange={(e) =>
                      onPatch({ kind: 'pitch-tie', pitchIdx: i, tied_to_next: e.target.checked })
                    }
                  />
                  <span>tie</span>
                </label>
                <label
                  className={styles.checkboxCell}
                  title="Laissez vibrer — open-ended ring with no target (harp, vibraphone)"
                >
                  <input
                    type="checkbox"
                    checked={lv}
                    disabled={isRest}
                    aria-label={`Laissez vibrer pitch ${i + 1} (${label})`}
                    onChange={(e) =>
                      onPatch({ kind: 'lv', pitchIdx: i, lv: e.target.checked })
                    }
                  />
                  <span>l.v.</span>
                </label>
                <label
                  className={styles.checkboxCell}
                  title="Enharmonic respell across the bar (C# → Db); relaxes the validator pitch-match check"
                >
                  <input
                    type="checkbox"
                    checked={enharmonic}
                    disabled={isRest}
                    aria-label={`Enharmonic respell pitch ${i + 1} (${label})`}
                    onChange={(e) =>
                      onPatch({
                        kind: 'enharmonic',
                        pitchIdx: i,
                        enharmonicTie: e.target.checked,
                      })
                    }
                  />
                  <span>enh.</span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Close
        </button>
      </div>
    </Popover>
  )
}
