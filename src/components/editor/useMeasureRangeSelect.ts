'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { resolveMeasureAt } from './resolveMeasureAt'

/**
 * Cmd/Ctrl+click on the staff area selects the measure at the click
 * position (M19-PR-6). Cmd/Ctrl+Shift+click extends the existing
 * range to include the clicked measure (or starts a new range if
 * none exists).
 *
 * The gesture intentionally piggybacks on Cmd/Ctrl rather than a
 * plain click because plain click is reserved for note selection
 * (`useNoteClickHandler`) and empty-staff click is reserved for
 * note insertion (`useStaffInteractions`). The Cmd/Ctrl modifier is
 * unbound in those gestures, so the measure-range selection has its
 * own input channel without conflict.
 *
 * Click resolution flow:
 *   1. Filter to staff-area clicks (not on the FloatingMenu, sidebar,
 *      or outside the SVG).
 *   2. Resolve the clicked logical staff via the Y coordinate.
 *   3. Resolve the clicked measureIdx via clickInsertSlot's SourceMap
 *      walk (the same path used for click-to-insert + chord-stack).
 *   4. Without Shift → set a single-bar range; per-event selection
 *      cleared so the bar-level keyboard shortcuts route through the
 *      new range.
 *   5. With Shift → extend the existing range (or seed a single-bar
 *      range if none).
 *
 * Mount-once: store reads happen via getState() inside handlers.
 */
export function useMeasureRangeSelect(scoreRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = scoreRef.current
    if (!container) return

    function onMouseDown(e: MouseEvent) {
      if (!container) return
      // Only act on Cmd/Ctrl+click; ignore plain clicks (those go to
      // note selection / empty-staff insert via the other hooks).
      if (!(e.ctrlKey || e.metaKey)) return

      const target = e.target as Element | null
      if (!target) return
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) return
      if (!svg.contains(target) && target !== svg) return

      const store = useChatStore.getState()
      const editedScore = store.editedScore
      if (!editedScore) return
      if (!store.editMap) return

      // Resolve the global measureIdx (staff from Y, measure from X) via the
      // shared helper — also used by the touch range-extend path.
      const measureIdx = resolveMeasureAt(svg, e.clientX, e.clientY, editedScore, store.editMap)
      if (measureIdx === undefined) return

      // Preempt the default browser/system gesture (Cmd+click can
      // toggle multiple selection in some contexts) and the parent
      // pointerup handlers (insert-note, deselect) which run on a plain
      // click — we don't want them firing for our modified click.
      e.preventDefault()
      e.stopPropagation()

      if (e.shiftKey) {
        store.extendMeasureRangeTo(measureIdx)
      } else {
        store.selectMeasureRange({
          fromStart: measureIdx,
          fromEnd: measureIdx,
        })
      }
      // Always clear per-event selection when the click mutates the
      // measure range (single-bar OR extend). Without this the user
      // would have both kinds of selection visible and the floating
      // menu would still be anchored to the prior event — the bar-
      // level keyboard shortcuts use the range path unambiguously
      // either way.
      if (store.selection) store.select(undefined)

      const range = useChatStore.getState().measureRangeSelection
      if (range) {
        const label =
          range.fromStart === range.fromEnd
            ? `bar ${range.fromStart + 1}`
            : `bars ${range.fromStart + 1}-${range.fromEnd + 1}`
        store.showStatusMessage(`Selected ${label}`)
      }
    }

    // mouseDOWN (not up) so the modifier-aware gesture fires on press — snappier
    // than waiting for release. Capture phase + preventDefault preempts the
    // system Cmd+click behavior. (The sibling insert-note path now runs on
    // pointerup and gates itself out on Cmd/Ctrl, so this is the desktop-only
    // modifier channel; touch uses long-press-to-arm instead, see
    // useScoreContextMenu + touchGestureBus.)
    container.addEventListener('mousedown', onMouseDown, { capture: true })
    return () => {
      container.removeEventListener('mousedown', onMouseDown, { capture: true })
    }
  }, [scoreRef])
}
