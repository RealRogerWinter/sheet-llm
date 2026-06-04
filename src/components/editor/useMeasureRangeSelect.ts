'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { clickInsertSlot } from './clickInsertSlot'
import { resolveStaffFromY } from './staffResolver'
import { getStaffCount } from '@/lib/music/scoreAccessors'

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

      // Resolve the logical staff under the click Y.
      const resolved = resolveStaffFromY(svg, e.clientY, getStaffCount(editedScore))
      if (!resolved) return

      // Resolve the measureIdx via the click-insert slot helper. We
      // discard insertAfterIdx — measure-range selection only needs
      // the bar identity, not the within-measure event slot.
      const slot = clickInsertSlot(
        svg,
        e.clientX,
        store.editMap,
        resolved.staffIdx,
        resolved.systemEl,
      )
      if (!slot || slot.measureIdx < 0) return

      // Preempt the default browser/system gesture (Cmd+click can
      // toggle multiple selection in some contexts) and the parent
      // mouseup handlers (insert-note, deselect) which run on a plain
      // click — we don't want them firing for our modified click.
      e.preventDefault()
      e.stopPropagation()

      if (e.shiftKey) {
        store.extendMeasureRangeTo(slot.measureIdx)
      } else {
        store.selectMeasureRange({
          fromStart: slot.measureIdx,
          fromEnd: slot.measureIdx,
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

    // Capture phase so we preempt useStaffInteractions' mouseup-based
    // insert-note path (capture-phase listener can stopPropagation
    // BEFORE the deeper handler runs). mouseDOWN here (vs. mouseup)
    // because the modifier-aware gesture should fire on press, not
    // release — feels snappier and avoids the "click then release"
    // delay the insert-note gesture has.
    container.addEventListener('mousedown', onMouseDown, { capture: true })
    return () => {
      container.removeEventListener('mousedown', onMouseDown, { capture: true })
    }
  }, [scoreRef])
}
