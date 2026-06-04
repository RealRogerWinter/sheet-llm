'use client'

import { useEffect, type RefObject } from 'react'
import { useEditorPrefsStore } from '@/lib/editor/prefsStore'

/**
 * One ladder step per this many accumulated wheel pixels. A mouse-wheel
 * notch is ~100px (deltaMode 0), so it steps once; small trackpad/pinch
 * deltas build up smoothly to one rung.
 */
const STEP_THRESHOLD_PX = 100

/**
 * Normalize wheel delta to pixels. deltaMode 0 = pixels (most
 * mice/trackpads), 1 = lines, 2 = pages — so a mouse reporting "3 lines"
 * doesn't under-step relative to a trackpad reporting pixels.
 */
function normalizedDeltaY(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16 // ~1 line ≈ 16px
  if (e.deltaMode === 2) return e.deltaY * 400 // ~1 page ≈ 400px
  return e.deltaY
}

/**
 * Wheel / pinch zoom for the score view. Attaches a native,
 * non-passive `wheel` listener to `ref` so it can `preventDefault` and
 * step the editor zoom on **Ctrl/⌘ + scroll**. Browsers synthesize
 * `ctrlKey` for trackpad pinch gestures, so the same handler gives
 * pinch-to-zoom for free. Plain wheel (no modifier) is deliberately
 * left untouched so the page still scrolls vertically — important now
 * that zoom-in grows the score downward instead of overflowing sideways.
 *
 * Stepping is delta-accumulated (see STEP_THRESHOLD_PX). The store is
 * read via `getState()` inside the handler so the listener stays
 * stable across zoom changes (no re-attach) and never closes over a
 * stale zoom value.
 */
export function useScoreWheelZoom(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    let accum = 0
    function onWheel(e: WheelEvent) {
      // Ctrl (mouse) / Meta (⌘) / browser-synthesized pinch (ctrlKey).
      if (!e.ctrlKey && !e.metaKey) return
      // Required so the browser's native page zoom doesn't also fire.
      e.preventDefault()
      accum += normalizedDeltaY(e)
      const { zoomIn, zoomOut } = useEditorPrefsStore.getState()
      // Scroll up / pinch open (negative delta) → zoom in; down → out.
      // The loops drain `accum` even at a ladder bound (zoomIn/zoomOut
      // no-op there) so it can't run away while pinned at min/max.
      while (accum <= -STEP_THRESHOLD_PX) {
        zoomIn()
        accum += STEP_THRESHOLD_PX
      }
      while (accum >= STEP_THRESHOLD_PX) {
        zoomOut()
        accum -= STEP_THRESHOLD_PX
      }
    }

    // passive:false is REQUIRED: wheel listeners default to passive in
    // modern browsers, where preventDefault() is a no-op (and warns).
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, enabled])
}
