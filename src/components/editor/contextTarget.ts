import type { Score } from '@/lib/music/types'
import { resolveClickPosition, type SourceMap } from '@/lib/music/scoreToAbcWithMap'
import { getStaffClef, getStaffCount, getVoiceEventAt } from '@/lib/music/scoreAccessors'
import { isRest } from '@/lib/music/eventKind'
import type { ContextTarget, MeasureRangeSelection, Selection } from '@/lib/chat/state'
import { clickInsertSlot } from './clickInsertSlot'
import { pitchFromY } from './staffGeometry'
import { resolveStaffFromY } from './staffResolver'
import { nearestPitchIdx } from './useNoteClickHandler'

/**
 * Minimal slice of a `contextmenu` / pointer event the classifier reads.
 * Accepting a plain shape (not a live `MouseEvent`) keeps the classifier
 * unit-testable with synthetic coordinates + a stubbed target element.
 */
export interface ContextPointer {
  clientX: number
  clientY: number
  target: EventTarget | null
}

/**
 * Read `data-startchar` off a clicked note/rest group. The attribute is
 * stamped on the selectable's own SVG group (`tagNoteheadsWithStartChar`,
 * ScorePanel.tsx), but tolerate it sitting on an ancestor/descendant so a
 * click on a child glyph (notehead path, stem) still resolves.
 */
function readStartChar(el: Element): number | undefined {
  const raw =
    el.getAttribute('data-startchar') ??
    el.closest('[data-startchar]')?.getAttribute('data-startchar') ??
    el.querySelector('[data-startchar]')?.getAttribute('data-startchar') ??
    null
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Classify what a right-click landed on, composing the same hit-test
 * resolvers every other editor gesture uses. The returned `ContextTarget`
 * drives which menu the ContextMenu renders (M27-PR-2+).
 *
 * SourceMap is the source of truth for measure identity — every
 * `measureIdx` comes from `resolveClickPosition` / `clickInsertSlot`,
 * never DOM order. `resolveStaffFromY` runs first so `systemEl` scopes
 * the later scans to ONE rendered system (skipping that scoping
 * reintroduces the #257 "upper click hits lower system" bug).
 *
 * Branch order mirrors `useStaffInteractions`:
 *   0. No staff resolves (pre-render / non-interactive) → `none`
 *      (caller must NOT preventDefault → native browser menu shows).
 *   1. Direct hit on `.abcjs-note` / `.abcjs-rest` → note / rest /
 *      chordNote (pitchIdx refined by click-Y for chords).
 *   2. Hit on `.abcjs-bar` → barline (measure inferred from X-band).
 *   3. Empty staff area → range (inside an active range) / measure /
 *      empty (blank score).
 */
export function classifyContextTarget(
  svg: SVGSVGElement,
  pointer: ContextPointer,
  editMap: SourceMap,
  editedScore: Score,
  activeRange: MeasureRangeSelection | undefined,
): ContextTarget {
  const targetEl = pointer.target instanceof Element ? pointer.target : null

  const resolved = resolveStaffFromY(svg, pointer.clientY, getStaffCount(editedScore))
  if (!resolved) return { kind: 'none' }

  const anchor = { anchorX: pointer.clientX, anchorY: pointer.clientY }

  // 1. Direct hit on a notehead / rest glyph.
  const noteEl = targetEl?.closest('.abcjs-note, .abcjs-rest') ?? null
  if (noteEl) {
    const sc = readStartChar(noteEl)
    const pos = sc !== undefined ? resolveClickPosition(editMap, sc) : undefined
    if (pos) {
      const event = getVoiceEventAt(editedScore, pos.staffIdx, pos.voiceIdx, pos.measureIdx, pos.eventIdx)
      const selection: Selection = {
        staffIdx: pos.staffIdx,
        voiceIdx: pos.voiceIdx,
        measureIdx: pos.measureIdx,
        eventIdx: pos.eventIdx,
        pitchIdx: pos.pitchIdx,
        ...anchor,
      }
      if (!event) return { kind: 'note', selection }
      if (isRest(event)) return { kind: 'rest', selection }
      if (event.pitches.length > 1) {
        // Chord: refine which notehead via click-Y, reading the geometry
        // of the staff the click actually landed on (grand-staff bass
        // clef differs) — exactly as the left-click path does.
        const clef = getStaffClef(editedScore, pos.staffIdx)
        const clicked = pitchFromY(svg, pointer.clientY, clef, resolved.staffEl)
        const pitchIdx =
          clicked && clicked.step !== 'rest'
            ? nearestPitchIdx(event.pitches, { step: clicked.step, octave: clicked.octave })
            : pos.pitchIdx ?? 0
        return { kind: 'chordNote', selection: { ...selection, pitchIdx } }
      }
      return { kind: 'note', selection }
    }
    // A note/rest element with an unresolvable startChar (mid-engrave
    // drift) falls through to the measure/empty path below.
  }

  // 2. Barline. measureIdx inferred from the nearest measure X-band
  //    (barlines aren't SourceMap-tagged). Preceding-vs-following
  //    barline-op semantics are finalized in M27-PR-3.
  const barEl = targetEl?.closest('.abcjs-bar') ?? null
  if (barEl) {
    const slot = clickInsertSlot(svg, pointer.clientX, editMap, resolved.staffIdx, resolved.systemEl)
    if (slot) return { kind: 'barline', measureIdx: slot.measureIdx, staffIdx: resolved.staffIdx }
  }

  // 3. Empty staff area → measure / range / empty.
  const slot = clickInsertSlot(svg, pointer.clientX, editMap, resolved.staffIdx, resolved.systemEl)
  if (slot) {
    if (activeRange && slot.measureIdx >= activeRange.fromStart && slot.measureIdx <= activeRange.fromEnd) {
      return { kind: 'range', range: activeRange }
    }
    return {
      kind: 'measure',
      measureIdx: slot.measureIdx,
      insertAfterIdx: slot.insertAfterIdx,
      staffIdx: resolved.staffIdx,
    }
  }
  return { kind: 'empty', staffIdx: resolved.staffIdx }
}
