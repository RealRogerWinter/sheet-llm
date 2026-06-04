'use client'

export interface LongPressOptions {
  /** Hold duration before firing (ms). */
  durationMs?: number
  /** Movement past this (px) cancels the press — it became a drag/scroll. */
  moveTolerancePx?: number
  /** Called with the originating pointerdown event when the hold completes. */
  onLongPress: (e: PointerEvent) => void
}

export interface LongPressHandlers {
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: (e: PointerEvent) => void
  onPointerCancel: (e: PointerEvent) => void
  /** Cancel any in-flight timer (call from effect cleanup). */
  dispose: () => void
}

/**
 * Long-press detector for touch/pen pointers. Imperative factory (not a hook)
 * so it composes into the mount-once editor pointer hooks. Mouse pointers are
 * ignored — desktop keeps its native right-click / `contextmenu`. The press is
 * cancelled if the pointer moves past `moveTolerancePx` (it was a drag/scroll)
 * or lifts before `durationMs`.
 *
 * iOS Safari does NOT synthesize a `contextmenu` from a long-press, so this is
 * the only way to reach the context menu / range-arm gesture there; on Android
 * (which DOES fire `contextmenu`) the caller dedupes via `touchGestureBus`.
 */
export function createLongPress({
  durationMs = 500,
  moveTolerancePx = 10,
  onLongPress,
}: LongPressOptions): LongPressHandlers {
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let startEvent: PointerEvent | null = null

  function clear() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    startEvent = null
  }

  return {
    onPointerDown(e) {
      if (e.pointerType === 'mouse') return
      if (!e.isPrimary) return
      clear()
      startX = e.clientX
      startY = e.clientY
      startEvent = e
      timer = setTimeout(() => {
        timer = null
        const origin = startEvent
        startEvent = null
        if (origin) onLongPress(origin)
      }, durationMs)
    },
    onPointerMove(e) {
      if (timer === null) return
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > moveTolerancePx) clear()
    },
    onPointerUp() {
      clear()
    },
    onPointerCancel() {
      clear()
    },
    dispose() {
      clear()
    },
  }
}
