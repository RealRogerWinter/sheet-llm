'use client'

import { useCallback } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { resolveClickPosition } from '@/lib/music/scoreToAbcWithMap'
import {
  getStaffClef,
  getStaffCount,
  getVoiceEventAt,
} from '@/lib/music/scoreAccessors'
import type { ClickListenerDrag } from '@/lib/abc/synth'
import type { Step } from '@/lib/music/types'
import { midiFromStep, pitchFromY } from './staffGeometry'
import { resolveStaffFromY } from './staffResolver'

interface AbcElem {
  startChar?: number
  endChar?: number
}

/** Return the index of the pitch in `event.pitches` nearest the
 *  clicked staff position by absolute MIDI distance (accidentals
 *  ignored — they don't change notehead Y). Exported for unit tests. */
export function nearestPitchIdx(
  pitches: Array<{ step: Step; octave: number }>,
  clicked: { step: Exclude<Step, 'rest'>; octave: number },
): number {
  const clickedMidi = midiFromStep(clicked.step, clicked.octave)
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < pitches.length; i++) {
    const p = pitches[i]
    if (p.step === 'rest') continue
    const m = midiFromStep(p.step as Exclude<Step, 'rest'>, p.octave)
    const d = Math.abs(m - clickedMidi)
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Stable abcjs clickListener. Resolves the clicked note element's
 * source char back to a (measureIdx, eventIdx, pitchIdx) Selection
 * via the SourceMap and writes it to the store.
 *
 * For chord events (>1 pitch) abcjs gives one selectable per group,
 * so the source-char alone can't tell us which notehead was clicked.
 * We refine pitchIdx by mapping the click Y to a staff pitch and
 * picking the chord tone with the nearest notehead position.
 *
 * abcjs's native dragging is disabled; pointer-event drag (horizontal
 * reorder, vertical retune, octave drag) is owned by useNoteDrag.
 * The drag argument abcjs still passes here is always `step: 0` and
 * is ignored.
 */
export function useNoteClickHandler() {
  return useCallback(
    (
      abcElem: unknown,
      _tuneNumber: number,
      _classes: unknown,
      _analysis: unknown,
      _drag: ClickListenerDrag | undefined,
      mouseEvent: MouseEvent,
    ) => {
      // Shift+click is the run-select gesture (D2), owned by useNoteDrag's
      // pointerup handler (it reads the prior selection as the run anchor).
      // Bail here so abcjs's click doesn't overwrite the run with a plain
      // single selection. Shift+DRAG (octave change) stays in useNoteDrag's
      // move branch and is unaffected.
      if (mouseEvent.shiftKey) return
      const { editMap, editedScore, select } = useChatStore.getState()
      const elem = abcElem as AbcElem
      if (!editMap || elem.startChar === undefined) return
      const sel = resolveClickPosition(editMap, elem.startChar)
      if (!sel) {
        select(undefined)
        return
      }

      // Refine pitchIdx for chord events using click Y. The clef in
      // play here is the CLICKED staff's clef — not necessarily the
      // primary staff's — so the bass-clef ladder gets used for clicks
      // landing on a grand-staff bass.
      let pitchIdx = sel.pitchIdx
      const event = editedScore
        ? getVoiceEventAt(editedScore, sel.staffIdx, sel.voiceIdx, sel.measureIdx, sel.eventIdx)
        : undefined
      if (event && event.pitches.length > 1) {
        const svg = (mouseEvent.target as Element | null)?.closest('svg') as SVGSVGElement | null
        const clef = editedScore ? getStaffClef(editedScore, sel.staffIdx) : 'treble'
        // Read the geometry of the staff the click actually landed on,
        // not the first `.abcjs-staff` in the SVG — on a grand staff
        // those are not the same group and the line-positions differ
        // by hundreds of pixels.
        const staffEl = svg && editedScore
          ? resolveStaffFromY(svg, mouseEvent.clientY, getStaffCount(editedScore))?.staffEl
          : undefined
        const clicked = svg ? pitchFromY(svg, mouseEvent.clientY, clef, staffEl) : undefined
        if (clicked && clicked.step !== 'rest') {
          pitchIdx = nearestPitchIdx(event.pitches, {
            step: clicked.step as Exclude<Step, 'rest'>,
            octave: clicked.octave,
          })
        }
      }

      select({
        staffIdx: sel.staffIdx,
        voiceIdx: sel.voiceIdx,
        measureIdx: sel.measureIdx,
        eventIdx: sel.eventIdx,
        pitchIdx,
        anchorX: mouseEvent.clientX,
        anchorY: mouseEvent.clientY,
      })
    },
    [],
  )
}
