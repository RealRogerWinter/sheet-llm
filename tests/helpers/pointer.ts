/**
 * jsdom pointer-event harness.
 *
 * jsdom (29.x) ships a `PointerEvent` constructor but does NOT implement the
 * pointer-capture methods (`setPointerCapture`/`releasePointerCapture`/
 * `hasPointerCapture`) — calling them throws. Production code guards capture in
 * try/catch, but that silently swallows the call in tests; installing no-op
 * stubs lets unit tests exercise the capture path faithfully. We also polyfill
 * `PointerEvent` itself (subclassing `MouseEvent`) on the off chance a runtime
 * lacks it, so the harness is portable across jsdom versions.
 */
export function installPointerEventPolyfills(): void {
  // No-op outside a DOM environment (the shared setup file also runs for
  // node-environment integration/auth/db tests, where Element/MouseEvent
  // don't exist).
  if (typeof document === 'undefined' || typeof Element === 'undefined') return

  const g = globalThis as unknown as {
    PointerEvent?: typeof PointerEvent
    window?: Window & typeof globalThis
  }

  if (typeof g.PointerEvent !== 'function') {
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number
      readonly pointerType: string
      readonly isPrimary: boolean
      readonly width: number
      readonly height: number
      readonly pressure: number
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params)
        this.pointerId = params.pointerId ?? 0
        this.pointerType = params.pointerType ?? 'mouse'
        this.isPrimary = params.isPrimary ?? false
        this.width = params.width ?? 1
        this.height = params.height ?? 1
        this.pressure = params.pressure ?? 0
      }
    }
    g.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
    if (g.window) g.window.PointerEvent = g.PointerEvent
  }

  const proto = Element.prototype as unknown as {
    setPointerCapture?: (id: number) => void
    releasePointerCapture?: (id: number) => void
    hasPointerCapture?: (id: number) => boolean
  }
  if (typeof proto.setPointerCapture !== 'function') {
    proto.setPointerCapture = () => {}
  }
  if (typeof proto.releasePointerCapture !== 'function') {
    proto.releasePointerCapture = () => {}
  }
  if (typeof proto.hasPointerCapture !== 'function') {
    proto.hasPointerCapture = () => false
  }
}

/** Dispatch a PointerEvent on a target. Defaults to a primary left pointer. */
export function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: PointerEventInit = {},
): PointerEvent {
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'touch',
    ...init,
  })
  target.dispatchEvent(e)
  return e
}
