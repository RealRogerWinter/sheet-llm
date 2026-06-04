'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore, effectiveActiveDuration } from '@/lib/chat/state'
import { smartInsertNote } from '@/lib/music/smartInsertNote'
import {
  getStaffClef,
  getStaffCount,
  getStaffMeasureAt,
} from '@/lib/music/scoreAccessors'
import type { Pitch, Step } from '@/lib/music/types'
import { clickInsertSlot } from './clickInsertSlot'
import { eventAtX } from './eventAtX'
import { pitchFromY } from './staffGeometry'
import { resolveStaffFromY } from './staffResolver'

/**
 * Staff-level interactions that don't involve a specific notehead:
 *
 *   1. Click on empty staff with a note selected → dismiss the menu.
 *   2. Click on empty staff with nothing selected → insert a default
 *      eighth note at that position (measure from x, pitch from y).
 *   3. Click outside the score (or floating menu) entirely → dismiss.
 *
 * Notehead-targeted gestures (click-to-select, drag-to-reorder,
 * drag-to-retune) are owned by useNoteClickHandler (abcjs's
 * clickListener pipeline) and useNoteDrag (pointer events).
 *
 * Uses pointer events (not mouse events) so tap-to-place works on touch
 * devices as well as mouse — a finger tap fires `pointerup` but NOT
 * `mouseup` synchronously the way a mouse click does. A tap-vs-drag guard
 * (compare pointerdown→pointerup travel against TAP_TOLERANCE_PX) means a
 * finger that scrolled the page no longer inserts a note (and fixes the
 * latent mouse equivalent: a small drag on empty staff used to insert).
 *
 * Mount-once: store reads happen via getState() inside handlers, so
 * the listener set never tears down on edits.
 */
// A pointer that travels more than this between down and up was a
// scroll/drag, not a tap — don't treat it as a place/deselect click.
// Mirrors the MIN_MOVE_PX click threshold in useNoteDrag.
const TAP_TOLERANCE_PX = 12

export function useStaffInteractions(scoreRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = scoreRef.current
    if (!container) return

    // Track the primary pointer's down position so pointerup can tell a tap
    // from a drag/scroll. Notehead pointerdowns are recorded too (harmless —
    // the pointerup handler early-returns on note/rest/bar targets anyway).
    let downX = 0
    let downY = 0
    let downId = -1
    let hasDown = false

    function onPointerDown(e: PointerEvent) {
      if (!e.isPrimary) return
      downX = e.clientX
      downY = e.clientY
      downId = e.pointerId
      hasDown = true
    }

    // Drop the armed tap if the gesture is cancelled (system gesture takeover,
    // pinch, etc.) so a later pointerup can't be mistaken for a tap.
    function onPointerCancel() {
      hasDown = false
    }

    function onPointerUp(e: PointerEvent) {
      if (!container) return
      // Only the primary pointer places a note — a second finger (e.g. during
      // a pinch) must never insert.
      if (!e.isPrimary) return
      // Tap-vs-drag: a pointer that moved past the tolerance was a scroll/drag,
      // not a tap. (Missing down record → treat as tap, preserving mouse-click
      // parity where a bare click has no measurable travel.)
      if (hasDown && e.pointerId === downId) {
        const traveled = Math.hypot(e.clientX - downX, e.clientY - downY)
        hasDown = false
        if (traveled > TAP_TOLERANCE_PX) return
      }
      // Cmd/Ctrl+click is owned by useMeasureRangeSelect (M19-PR-6)
      // for measure-range selection. Without this gate the modified
      // click would still fall through into the insert-note / deselect
      // path on pointerup (pointerdown.stopPropagation doesn't stop the
      // subsequent pointerup), and the user would get an unintended
      // note inserted into the empty staff area they Cmd+clicked.
      if (e.ctrlKey || e.metaKey) return
      const target = e.target as Element | null
      if (!target) return
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) return

      if (target.closest('.abcjs-note, .abcjs-rest, .abcjs-bar, .abcjs-midi-controls')) return

      const store = useChatStore.getState()
      const editedScore = store.editedScore
      if (!editedScore) return

      if (store.selection) {
        store.select(undefined)
        return
      }

      const staffGroup = target.closest('.abcjs-staff') ?? svg.querySelector('.abcjs-staff')
      if (!staffGroup) return

      // Resolve which LOGICAL staff the click landed on first — bass-
      // clef and multi-staff scores need a clef-aware Y→pitch mapping
      // AND a staff-aware destination for the inserted note. The
      // resolver maps the click Y through `.abcjs-staff-wrapper`
      // grouping to recover the logical staff index (0..staffCount-1)
      // rather than the raw DOM position of `.abcjs-staff`, which
      // grows with the number of rendered systems.
      const resolved = resolveStaffFromY(svg, e.clientY, getStaffCount(editedScore))
      if (!resolved) return
      const clickedStaffIdx = resolved.staffIdx
      const clickedClef = getStaffClef(editedScore, clickedStaffIdx)
      const defaultPitch: { step: Step; octave: number } =
        clickedClef === 'bass' ? { step: 'F', octave: 3 } : { step: 'C', octave: 4 }
      const pitch =
        pitchFromY(svg, e.clientY, clickedClef, resolved.staffEl) ?? defaultPitch

      // Implicit-merge: if the click X falls on an existing event
      // (and Alt isn't held to force a new event), stack into the
      // chord at that beat instead of inserting a new event.
      // Filter to the resolved staff so a chord click on the bass
      // doesn't merge into a treble note at the same X (and vice
      // versa).
      if (!e.altKey && store.editMap) {
        const hit = eventAtX(svg, e.clientX, store.editMap, resolved.systemEl, clickedStaffIdx)
        if (hit) {
          const target = getStaffMeasureAt(editedScore, hit.staffIdx, hit.measureIdx)?.events[hit.eventIdx]
          if (target && target.pitches[0]?.step !== 'rest' && target.pitches.length < 6) {
            const already = target.pitches.some(
              (p) =>
                p.step === pitch.step &&
                p.octave === pitch.octave &&
                (p.accidental ?? 'none') === 'none',
            )
            if (already) {
              store.showStatusMessage(`${pitch.step}${pitch.octave} is already in this chord`)
              return
            }
            try {
              store.applyEdit({
                kind: 'addPitchToChord',
                target: hit,
                pitch: { step: pitch.step, octave: pitch.octave },
              })
              store.showStatusMessage(
                `Stacked ${pitch.step}${pitch.octave} into chord (m.${hit.measureIdx + 1})`,
              )
            } catch {
              store.showStatusMessage(`Could not stack ${pitch.step}${pitch.octave} (m.${hit.measureIdx + 1})`)
            }
            return
          }
        }
      }

      // Resolve insertion slot from the click X. Returns the GLOBAL
      // (score-level) measure index plus the within-measure
      // insertAfterIdx, both derived from the SourceMap-tagged
      // `[data-startchar]` elements. Falls back to the last measure /
      // append-only behavior when the system has no tagged events on
      // the clicked staff (e.g. before the first render).
      const slot = store.editMap
        ? clickInsertSlot(svg, e.clientX, store.editMap, clickedStaffIdx, resolved.systemEl)
        : undefined
      const measureIdx = slot?.measureIdx ?? -1
      const measure = measureIdx >= 0
        ? getStaffMeasureAt(editedScore, clickedStaffIdx, measureIdx)
        : undefined
      if (!measure) return
      const insertAfterIdx = slot?.insertAfterIdx ?? measure.events.length - 1
      // Click-to-insert lands on the clicked staff's primary voice. To
      // target an extra voice (V2..V4), the user can select an existing
      // note in that voice first and then use +Note from the toolbar.
      // Duration and accidental come from the toolbar's note picker so
      // the user controls what's about to be placed.
      const insertedPitch: Pitch = { step: pitch.step, octave: pitch.octave }
      if (store.activeAccidental !== 'none') {
        insertedPitch.accidental = store.activeAccidental
      }
      const result = smartInsertNote(
        editedScore,
        { measureIdx, eventIdx: insertAfterIdx },
        {
          pitches: [insertedPitch],
          duration: effectiveActiveDuration(store.activeDuration, store.activeDotted),
        },
        clickedStaffIdx,
        0,
      )
      store.applyScore(result.score, {
        selection: result.newSelection,
        statusMessage: result.statusMessage ?? `Inserted ${pitch.step}${pitch.octave} in m.${measureIdx + 1}`,
      })
    }

    function onDocumentPointerDown(e: PointerEvent) {
      if (!container) return
      const target = e.target as Node | null
      if (!target) return
      if (container.contains(target)) return
      const menu = document.querySelector('[role="toolbar"][aria-label="Edit selected note"]')
      if (menu && menu.contains(target)) return
      const store = useChatStore.getState()
      if (store.selection) store.select(undefined)
    }

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('pointerdown', onDocumentPointerDown)
    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('pointerdown', onDocumentPointerDown)
    }
  }, [scoreRef])
}
