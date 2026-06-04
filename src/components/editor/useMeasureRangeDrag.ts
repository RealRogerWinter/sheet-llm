'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore, type MeasureRangeSelection } from '@/lib/chat/state'
import { clickInsertSlot } from './clickInsertSlot'
import { resolveStaffFromY } from './staffResolver'
import { getStaffCount } from '@/lib/music/scoreAccessors'

const DRAG_THRESHOLD_PX = 4

/**
 * Pointer-drag for the M19-PR-8 MOVE gesture. When the user
 * pointerdowns on a HIGHLIGHTED measure (inside the
 * measureRangeSelection bounds) and moves past
 * DRAG_THRESHOLD_PX (4px), the drag begins:
 *
 *   - measureDragState is populated on every pointermove
 *     (clientX + resolved toAfter target).
 *   - The MeasureRangeHighlight overlay reads measureDragState to
 *     show a drop-indicator vertical line at the live cursor X.
 *   - On pointerup, the resolved toAfter is dispatched as a
 *     dragMeasureRange-move op, the drag state clears, and the
 *     range-selection is updated to the new destination so the
 *     highlight follows the moved content.
 *
 * Cancellation paths:
 *   - Esc key: handled by useEditorKeyboard.clearSelection → also
 *     clears measureRangeSelection AND measureDragState (the latter
 *     happens automatically since the dispatch clears it via store
 *     setMeasureDragState).
 *   - Pointerup OVER the source range (toAfter === null): no-op
 *     drop; drag state clears, range stays.
 *   - Pointerup OUTSIDE the SVG: no-op (no valid toAfter).
 *
 * Gate: drag is initiated ONLY by plain pointerdown over a
 * highlighted bar (no Cmd/Ctrl/Shift modifier — those are owned by
 * useMeasureRangeSelect for range manipulation). The handler runs
 * in CAPTURE phase to preempt other pointer handlers (the
 * MUST-FIX-#5 review fix below explicitly bails when the pointer
 * lands on a `.abcjs-note` so useNoteDrag owns notehead-drag
 * gestures unambiguously — without this, dragging a notehead inside
 * a highlighted range would fire BOTH `reorderBalanced` AND
 * `dragMeasureRange-move` on the same pointerup, corrupting the
 * score state and undo history).
 *
 * Implementation note: pointermove/up listeners attach to the
 * WINDOW (not the container) so a fast drag that exits the score
 * area still tracks correctly. The container-mounted pointerdown
 * is the only listener that needs ref scoping.
 */
export function useMeasureRangeDrag(scoreRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = scoreRef.current
    if (!container) return

    let dragOrigin: { clientX: number; clientY: number; sourceRange: MeasureRangeSelection } | null = null
    let dragActive = false

    function isInsideRange(measureIdx: number, range: MeasureRangeSelection): boolean {
      return measureIdx >= range.fromStart && measureIdx <= range.fromEnd
    }

    function resolveToAfter(
      clientX: number,
      clientY: number,
      sourceRange: MeasureRangeSelection,
    ): number | null {
      if (!container) return null
      const store = useChatStore.getState()
      if (!store.editedScore || !store.editMap) return null
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) return null
      const resolved = resolveStaffFromY(svg, clientY, getStaffCount(store.editedScore))
      if (!resolved) return null
      const slot = clickInsertSlot(
        svg,
        clientX,
        store.editMap,
        resolved.staffIdx,
        resolved.systemEl,
      )
      if (!slot || slot.measureIdx < 0) return null
      const targetMeasure = slot.measureIdx
      // Inside-source drop is a no-op; signal with null.
      if (isInsideRange(targetMeasure, sourceRange)) return null
      // Convert "cursor is over bar N (not in source)" into a
      // toAfter value the op consumes. Convention: dropping on a
      // bar to the LEFT of the source moves the range to start at
      // that bar → toAfter = targetMeasure - 1. Dropping to the
      // RIGHT moves it to end at targetMeasure → toAfter =
      // targetMeasure. The op layer also rejects toAfter that
      // overlaps [fromStart-1..fromEnd] (no-op) — that case is
      // already filtered by the inside-source check above.
      if (targetMeasure < sourceRange.fromStart) {
        // Drop before the range: land at targetMeasure → toAfter = targetMeasure - 1.
        return targetMeasure - 1
      }
      // targetMeasure > sourceRange.fromEnd (the other branch).
      return targetMeasure
    }

    function onPointerDown(e: PointerEvent) {
      // Plain primary-button pointerdown only — no modifier (those
      // are owned by useMeasureRangeSelect).
      if (e.button !== 0) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (!container) return
      const target = e.target as Element | null
      if (!target) return
      // Bail when the pointer lands on a notehead — useNoteDrag owns
      // notehead-drag gestures (reorder + retune + cross-staff move).
      // Without this gate, dragging a note INSIDE a highlighted range
      // would arm BOTH this hook AND useNoteDrag; both fire on
      // pointerup and produce a double-dispatch that corrupts score
      // state. Same `.abcjs-note` selector useNoteDrag's own filter
      // uses (see useNoteDrag.ts pointerdown gate).
      if (target.closest('.abcjs-note, .abcjs-rest')) return
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) return
      // The drag only initiates if the pointer is over the HIGHLIGHTED
      // bar area (i.e. the cursor is inside the bounds of a measure
      // that's within the current measureRangeSelection). Cheapest
      // check: resolve cursor → measureIdx via clickInsertSlot, then
      // test inside-range.
      const store = useChatStore.getState()
      const range = store.measureRangeSelection
      if (!range) return
      if (!store.editedScore || !store.editMap) return
      const resolved = resolveStaffFromY(svg, e.clientY, getStaffCount(store.editedScore))
      if (!resolved) return
      const slot = clickInsertSlot(svg, e.clientX, store.editMap, resolved.staffIdx, resolved.systemEl)
      if (!slot || slot.measureIdx < 0) return
      if (!isInsideRange(slot.measureIdx, range)) return

      dragOrigin = {
        clientX: e.clientX,
        clientY: e.clientY,
        sourceRange: range,
      }
      dragActive = false
      // Don't preempt other pointerdown handlers yet — wait until
      // the threshold is crossed (the user might just be clicking,
      // not dragging).
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragOrigin) return
      if (!dragActive) {
        const dx = e.clientX - dragOrigin.clientX
        const dy = e.clientY - dragOrigin.clientY
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        dragActive = true
      }
      const toAfter = resolveToAfter(e.clientX, e.clientY, dragOrigin.sourceRange)
      useChatStore.getState().setMeasureDragState({
        sourceRange: dragOrigin.sourceRange,
        clientX: e.clientX,
        toAfter,
      })
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragOrigin) return
      const wasActive = dragActive
      const sourceRange = dragOrigin.sourceRange
      dragOrigin = null
      dragActive = false
      if (!wasActive) {
        // Threshold never crossed — treat as a click. No-op for the
        // drag pipeline. Clear any stale drag state defensively.
        useChatStore.getState().setMeasureDragState(undefined)
        return
      }
      const toAfter = resolveToAfter(e.clientX, e.clientY, sourceRange)
      const store = useChatStore.getState()
      store.setMeasureDragState(undefined)
      if (toAfter === null) {
        store.showStatusMessage('Drop on the source range is a no-op')
        return
      }
      const rangeLen = sourceRange.fromEnd - sourceRange.fromStart + 1
      try {
        store.applyEdit({
          kind: 'dragMeasureRange',
          mode: 'move',
          fromStart: sourceRange.fromStart,
          fromEnd: sourceRange.fromEnd,
          toAfter,
        })
        // Update the range selection to where the moved content
        // landed so the highlight follows. The op layer's math:
        // destination first-bar lands at (toAfter < fromStart ?
        // toAfter + 1 : toAfter - rangeLen + 1).
        const destStart =
          toAfter < sourceRange.fromStart ? toAfter + 1 : toAfter - rangeLen + 1
        store.selectMeasureRange({
          fromStart: destStart,
          fromEnd: destStart + rangeLen - 1,
        })
        store.showStatusMessage(
          rangeLen === 1
            ? `Moved bar to position ${destStart + 1}`
            : `Moved ${rangeLen} bars to start at bar ${destStart + 1}`,
        )
      } catch {
        // EditError surfaces via the store's error toast; no
        // additional cleanup needed since setMeasureDragState
        // already cleared.
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && dragOrigin) {
        dragOrigin = null
        dragActive = false
        useChatStore.getState().setMeasureDragState(undefined)
      }
    }

    container.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [scoreRef])
}
