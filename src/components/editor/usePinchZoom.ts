'use client'

import { useEffect, type RefObject } from 'react'
import { useEditorPrefsStore, ZOOM_LEVELS, type ZoomLevel } from '@/lib/editor/prefsStore'
import { touchGestureBus } from './touchGestureBus'

/** Snap an arbitrary zoom factor to the nearest discrete ladder level. */
function nearestZoom(target: number): ZoomLevel {
  let best: ZoomLevel = ZOOM_LEVELS[0]
  let bestDiff = Infinity
  for (const z of ZOOM_LEVELS) {
    const d = Math.abs(z - target)
    if (d < bestDiff) {
      bestDiff = d
      best = z
    }
  }
  return best
}

/**
 * Two-finger pinch-zoom for the score view on touchscreens. The wheel handler
 * (useScoreWheelZoom) covers trackpad pinch via the browser's synthesized
 * ctrlKey-wheel, but touchscreens don't synthesize that — so we track two
 * touch pointers directly and map their distance ratio onto the discrete
 * ZOOM_LEVELS ladder: `desiredZoom = startZoom × (currentDist / startDist)`,
 * snapped to the nearest rung (the ladder is non-geometric, so a log mapping
 * would drift). `setZoom` fires only when the rung changes.
 *
 * Mounted next to useScoreWheelZoom on the score-area wrapper. While a pinch is
 * active it sets `touchGestureBus.pinchActive` so useNoteDrag aborts any
 * in-flight single-finger drag (the second finger is `isPrimary:false`, which
 * useNoteDrag already ignores, but under `touch-action: none` the browser won't
 * auto-`pointercancel` the first finger — so the flag is the explicit signal).
 *
 * Reads/writes the zoom store via getState() so the listener set is stable.
 */
export function usePinchZoom(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    const pointers = new Map<number, { x: number; y: number }>()
    let startDist = 0
    let startZoom: ZoomLevel = useEditorPrefsStore.getState().zoom

    function distance(): number {
      const pts = [...pointers.values()]
      if (pts.length < 2) return 0
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
    }

    function onPointerDown(e: PointerEvent) {
      if (e.pointerType !== 'touch') return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        startDist = distance()
        startZoom = useEditorPrefsStore.getState().zoom
        touchGestureBus.setPinchActive(true)
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size !== 2 || startDist === 0) return
      // Own the gesture — stop the browser treating it as page zoom/scroll.
      e.preventDefault()
      const ratio = distance() / startDist
      const target = nearestZoom(startZoom * ratio)
      const { zoom, setZoom } = useEditorPrefsStore.getState()
      if (target !== zoom) setZoom(target)
    }

    function endPointer(e: PointerEvent) {
      if (!pointers.delete(e.pointerId)) return
      if (pointers.size < 2) {
        startDist = 0
        touchGestureBus.setPinchActive(false)
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    // passive:false so preventDefault() during a 2-finger move is honored.
    el.addEventListener('pointermove', onPointerMove, { passive: false })
    el.addEventListener('pointerup', endPointer)
    el.addEventListener('pointercancel', endPointer)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', endPointer)
      el.removeEventListener('pointercancel', endPointer)
      touchGestureBus.setPinchActive(false)
    }
  }, [ref, enabled])
}
