'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore, type Selection } from '@/lib/chat/state'
import { getStaffMeasureAt, getStaffMeasures, getVoiceMeasureAt } from '@/lib/music/scoreAccessors'
import { resolveClickPosition } from '@/lib/music/scoreToAbcWithMap'
import { DURATION_32NDS } from '@/lib/music/measureBalance'
import { snapTargetAtX, dragSnapIsReorder, type SnapTarget } from './snapTargetAtX'
import { touchGestureBus } from './touchGestureBus'
import type { Event } from '@/lib/music/types'

function cumulativeBoundaries(events: readonly Event[]): number[] {
  const out: number[] = [0]
  let acc = 0
  for (const e of events) {
    acc += DURATION_32NDS[e.duration]
    out.push(acc)
  }
  return out
}

function sameTarget(a: SnapTarget | undefined, b: SnapTarget | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.staffIdx === b.staffIdx &&
    a.measureIdx === b.measureIdx &&
    a.position32nds === b.position32nds
  )
}

const DEAD_ZONE_PX = 4
const MIN_MOVE_PX = 12
const MAX_STEPS = 14
const MAX_OCTAVES = 2

interface DragState {
  noteEl: SVGGElement
  sel: Selection
  startX: number
  startY: number
  moved: boolean
  stepPx: number
  lastSnapTarget: SnapTarget | undefined
}

function getStaffYPositions(svg: SVGSVGElement): number[] | undefined {
  const staff = svg.querySelector('.abcjs-staff')
  if (!staff) return undefined
  const lines = staff.querySelectorAll('path')
  const ys: number[] = []
  for (const path of lines) {
    const d = path.getAttribute('d') ?? ''
    const m = d.match(/M\s*[\d.-]+\s+([\d.-]+)/)
    if (m) ys.push(parseFloat(m[1]))
  }
  ys.sort((a, b) => a - b)
  return ys.length >= 5 ? ys.slice(0, 5) : undefined
}

function measureStaffStepPx(svg: SVGSVGElement): number {
  const ys = getStaffYPositions(svg)
  if (!ys) return 4
  const stepSvg = (ys[4] - ys[0]) / 8
  const rect = svg.getBoundingClientRect()
  const vbHeight = svg.viewBox?.baseVal?.height ?? rect.height
  if (!vbHeight) return 4
  return stepSvg * (rect.height / vbHeight)
}

function resolveSelFromNoteEl(noteEl: SVGGElement): Selection | undefined {
  const raw = noteEl.getAttribute('data-startchar')
  if (!raw) return undefined
  const startChar = Number(raw)
  if (!Number.isFinite(startChar)) return undefined
  const editMap = useChatStore.getState().editMap
  if (!editMap) return undefined
  return resolveClickPosition(editMap, startChar)
}

function computeReorderSelection(
  prevSel: Selection,
  direction: 'left' | 'right',
): Pick<Selection, 'staffIdx' | 'measureIdx' | 'eventIdx' | 'pitchIdx'> {
  const { editedScore } = useChatStore.getState()
  const staffIdx = prevSel.staffIdx ?? 0
  const base = {
    staffIdx,
    measureIdx: prevSel.measureIdx,
    eventIdx: prevSel.eventIdx,
    pitchIdx: prevSel.pitchIdx,
  }
  if (!editedScore) return base
  const measures = getStaffMeasures(editedScore, staffIdx)
  const m = prevSel.measureIdx
  const e = prevSel.eventIdx
  const measure = measures[m]
  if (!measure) return base
  if (direction === 'right') {
    if (e < measure.events.length - 1) return { ...base, eventIdx: e + 1 }
    if (m < measures.length - 1) return { ...base, measureIdx: m + 1, eventIdx: 0 }
    return base
  }
  if (e > 0) return { ...base, eventIdx: e - 1 }
  if (m > 0) {
    const prev = measures[m - 1]
    return { ...base, measureIdx: m - 1, eventIdx: prev.events.length - 1 }
  }
  return base
}

/**
 * Pointer-event drag system for individual noteheads.
 *
 * Free 2D drag: the note follows the pointer in both X and Y so the
 * user can drag diagonally to reach a measure on a different system
 * (line) of the score. On release the intent is disambiguated by the
 * live snap target:
 *   - snap target ≠ source position  → reorderBalanced to that target
 *     (works across barlines AND across systems on the same staff).
 *   - snap target == source position → changePitch by the vertical
 *     step delta (shift = octave).
 *   - movement under MIN_MOVE_PX     → treat as click → select.
 *   - ESC during drag                → cancel.
 *
 * Tuplet boundaries are blocked with a status message — tuplet-aware
 * reorder is a separate feature.
 *
 * Mount-once. Store reads happen via getState() inside handlers.
 */
export function useNoteDrag(scoreRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = scoreRef.current
    if (!container) return

    let drag: DragState | undefined

    function onPointerDown(e: PointerEvent) {
      // A second concurrent touch (a pinch starting) while a drag is in flight
      // aborts the drag eagerly — don't wait for finger 1 to move, and don't
      // let finger 1's later release dispatch a stray edit.
      if (drag && e.pointerType === 'touch' && !e.isPrimary) {
        cancelDrag()
        return
      }
      if (!e.isPrimary || e.button !== 0) return
      const target = e.target as Element | null
      const noteEl = target?.closest('.abcjs-note') as SVGGElement | null
      if (!noteEl) return
      const sel = resolveSelFromNoteEl(noteEl)
      if (!sel) return
      const svg = container?.querySelector('svg') as SVGSVGElement | null
      if (!svg) return
      const stepPx = measureStaffStepPx(svg)
      drag = {
        noteEl,
        sel,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        stepPx,
        lastSnapTarget: undefined,
      }
      try {
        noteEl.setPointerCapture(e.pointerId)
      } catch {
        // Some environments (jsdom) don't support pointer capture.
      }
      e.stopPropagation()
    }

    function onPointerMove(e: PointerEvent) {
      if (!drag) return
      // A second finger started a pinch-zoom — abort the drag (clears the
      // notehead transform + drag state). Under touch-action:none the browser
      // won't auto-pointercancel the first finger, so this is the explicit
      // hand-off to usePinchZoom.
      if (touchGestureBus.isPinchActive()) {
        cancelDrag()
        return
      }
      if (!drag.noteEl.isConnected) {
        drag = undefined
        return
      }
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DEAD_ZONE_PX) return
        drag.moved = true
      }
      // Free diagonal motion: the notehead follows the pointer in both
      // axes so the user can drag down-and-right to reach a measure on
      // the next system. Snap math is what disambiguates intent on
      // release.
      drag.noteEl.setAttribute('transform', `translate(${dx},${dy})`)
      // 2D-snap: compute the nearest event boundary in (x, y) so a
      // downward drag finds bars on the next system. Restrict to the
      // source staff (cross-staff moves would require a different
      // transform op). Only publish when the snap point actually
      // changes — keeps re-renders proportional to boundary crossings,
      // not every pointermove.
      const svg = container?.querySelector('svg') as SVGSVGElement | null
      const storeState = useChatStore.getState()
      const editMap = storeState.editMap
      const score = storeState.editedScore
      if (svg && editMap && score) {
        // Strip the live transform from the dragged notehead just for
        // the snap measurement. snapTargetAtX reads every
        // `[data-startchar]` element's getBoundingClientRect to build
        // its candidate points — including the source's. With the drag
        // transform in place, the source's trailing snap point follows
        // the pointer Y while its leading snap point stays on the
        // original row, so a pure vertical drag always lands closer to
        // the trailing point and routes through `reorderBalanced`
        // instead of `changePitch`. Strip-measure-restore is one layout
        // thrash per pointermove and keeps the same visual feedback.
        drag.noteEl.removeAttribute('transform')
        const snap = snapTargetAtX(
          svg,
          e.clientX,
          editMap,
          score,
          drag.sel.staffIdx ?? 0,
          e.clientY,
        )
        drag.noteEl.setAttribute('transform', `translate(${dx},${dy})`)
        if (!sameTarget(snap, drag.lastSnapTarget)) {
          drag.lastSnapTarget = snap
          storeState.setDragSnapTarget(snap)
        }
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (!drag) return
      // If a pinch is active (the eager abort may have been missed, e.g. the
      // 2nd pointerdown reached usePinchZoom but not here), discard the drag
      // without dispatching an edit.
      if (touchGestureBus.isPinchActive()) {
        cancelDrag()
        return
      }
      const { sel, noteEl, stepPx, lastSnapTarget, moved } = drag
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      const dist = Math.hypot(dx, dy)
      noteEl.removeAttribute('transform')
      drag = undefined

      const store = useChatStore.getState()
      const anchor = { anchorX: e.clientX, anchorY: e.clientY }
      // Always clear the snap indicator on release.
      store.setDragSnapTarget(undefined)

      // Pure click or below the move threshold → select.
      if (!moved || dist < MIN_MOVE_PX) {
        // Shift+click extends a RUN selection (D2) from the prior single
        // selection (the anchor) to the clicked event, when both are in
        // the same voice + measure and differ. The caret moves to the
        // clicked end; selectRun() then re-sets the run (select() clears
        // it). Shift+click with no compatible anchor falls through to a
        // plain select — and seeds the anchor for a subsequent extend.
        if (e.shiftKey) {
          const prev = store.selection
          if (
            prev &&
            (prev.staffIdx ?? 0) === (sel.staffIdx ?? 0) &&
            prev.voiceIdx === sel.voiceIdx &&
            prev.measureIdx === sel.measureIdx &&
            prev.eventIdx !== sel.eventIdx
          ) {
            store.select({ ...sel, ...anchor })
            store.selectRun({
              staffIdx: sel.staffIdx ?? 0,
              voiceIdx: sel.voiceIdx ?? 0,
              measureIdx: sel.measureIdx,
              startEventIdx: Math.min(prev.eventIdx, sel.eventIdx),
              endEventIdx: Math.max(prev.eventIdx, sel.eventIdx),
            })
            return
          }
        }
        store.select({ ...sel, ...anchor })
        return
      }

      const editedScore = store.editedScore
      if (!editedScore) {
        store.select({ ...sel, ...anchor })
        return
      }

      const staffIdx = sel.staffIdx ?? 0
      const voiceIdx = sel.voiceIdx ?? 0
      const measure = getStaffMeasureAt(editedScore, staffIdx, sel.measureIdx)
      if (!measure) {
        store.select({ ...sel, ...anchor })
        return
      }

      // Disambiguate reorder vs pitch change by whether the drop landed
      // OUTSIDE the dragged event's own horizontal slot. An event spans
      // [leadingPos, trailingPos); snapping onto EITHER boundary means
      // the pointer never left the note's slot (a straight-down drag is
      // a pitch change, not a move toward another bar). Matching only
      // the leading boundary — the historical behavior — misread nearly
      // every vertical drag as a reorder, because snapTargetAtX returns
      // whichever own-boundary is nearer the notehead center and that's
      // usually the trailing one. See dragSnapIsReorder for the full
      // rationale. Use the SELECTED voice's measure so the cumulative
      // 32nd offsets line up with snapTargetAtX's per-voice numbering.
      const voiceMeasure =
        getVoiceMeasureAt(editedScore, staffIdx, voiceIdx, sel.measureIdx) ?? measure
      const srcBoundaries = cumulativeBoundaries(voiceMeasure.events)
      const srcLeadingPos = srcBoundaries[sel.eventIdx]
      const srcTrailingPos = srcBoundaries[sel.eventIdx + 1]
      const isReorder = dragSnapIsReorder(lastSnapTarget, {
        staffIdx,
        measureIdx: sel.measureIdx,
        leadingPos32nds: srcLeadingPos,
        trailingPos32nds: srcTrailingPos,
      })

      if (isReorder && lastSnapTarget) {
        const target = {
          measureIdx: lastSnapTarget.measureIdx,
          position32nds: lastSnapTarget.position32nds,
        }
        const prevScore = store.editedScore
        store.applyBalancedEdit(
          {
            kind: 'reorderBalanced',
            selection: { staffIdx, voiceIdx, measureIdx: sel.measureIdx, eventIdx: sel.eventIdx },
            target,
          },
          `reorder-balanced:${sel.measureIdx}:${sel.eventIdx}`,
        )
        const newScore = useChatStore.getState().editedScore
        if (newScore === prevScore) {
          // Op failed (statusMessage set by store); keep selection on
          // the original event.
          return
        }
        const direction: 'left' | 'right' =
          target.measureIdx > sel.measureIdx ||
          (target.measureIdx === sel.measureIdx && target.position32nds > srcLeadingPos)
            ? 'right'
            : 'left'
        const newPos = computeReorderSelection(sel, direction)
        store.select({ ...newPos, ...anchor })
        return
      }

      // No positional change → fall back to vertical pitch change. Use
      // raw dy / stepPx (not the snap-target y) so behavior matches the
      // pre-2D-drag intent on single-system scores.
      const snapSteps = Math.round(dy / stepPx)
      if (snapSteps === 0) {
        store.select({ ...sel, ...anchor })
        return
      }
      const deltaStep = -snapSteps
      if (e.shiftKey) {
        const deltaOctave = Math.max(
          -MAX_OCTAVES,
          Math.min(MAX_OCTAVES, Math.round(deltaStep / 7)),
        )
        if (deltaOctave !== 0) {
          store.applyEdit(
            { kind: 'changePitch', target: sel, deltaOctave },
            `drag:${sel.measureIdx}:${sel.eventIdx}`,
          )
        }
      } else {
        const clamped = Math.max(-MAX_STEPS, Math.min(MAX_STEPS, deltaStep))
        if (clamped !== 0) {
          store.applyEdit(
            { kind: 'changePitch', target: sel, deltaStep: clamped },
            `drag:${sel.measureIdx}:${sel.eventIdx}`,
          )
        }
      }
    }

    function cancelDrag() {
      if (drag) {
        try {
          drag.noteEl.removeAttribute('transform')
        } catch {
          // ignore: element may already be detached
        }
        drag = undefined
        useChatStore.getState().setDragSnapTarget(undefined)
      }
    }

    function onPointerCancel() {
      cancelDrag()
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && drag) {
        cancelDrag()
      }
    }

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [scoreRef])
}
