/**
 * Tiny module-level bus that decouples the imperative touch-gesture hooks
 * (useScoreContextMenu, useStaffInteractions) without prop-drilling. Holds two
 * pieces of transient, per-page-load state (booleans + one timestamp; nothing
 * sensitive):
 *
 *  - a "context-menu came from touch" window — opened on a touch/pen
 *    pointerdown so that the native `contextmenu` event (which Android fires on
 *    long-press, possibly BEFORE our pointer-timer) is always deferred to our
 *    long-press handler. This both dedupes Android's double-fire AND keeps the
 *    gesture consistent with iOS (where no native `contextmenu` fires at all),
 *    so a long-press on a bar arms range-select on every platform.
 *  - a `rangeArmed` flag — set when a long-press on a bar entered touch
 *    measure-range mode, so subsequent taps extend the range (in
 *    useStaffInteractions) instead of placing a note.
 */
let contextMenuFromTouchUntil = 0
let rangeArmed = false
let pinchActive = false

export const touchGestureBus = {
  /** Mark that a touch/pen gesture is in progress (call on pointerdown). */
  markTouchContextMenu(ms = 1000): void {
    contextMenuFromTouchUntil = Date.now() + ms
  },
  /** True while a native `contextmenu` should be deferred to our long-press. */
  isTouchContextMenuPending(): boolean {
    return Date.now() < contextMenuFromTouchUntil
  },
  /** Enter touch measure-range mode (taps extend the range). */
  armRange(): void {
    rangeArmed = true
  },
  disarmRange(): void {
    rangeArmed = false
  },
  isRangeArmed(): boolean {
    return rangeArmed
  },
  /**
   * True while a two-finger pinch-zoom is in progress. useNoteDrag reads this
   * to abort an in-flight note drag when a second finger lands (the browser
   * won't auto-`pointercancel` under `touch-action: none`).
   */
  setPinchActive(v: boolean): void {
    pinchActive = v
  },
  isPinchActive(): boolean {
    return pinchActive
  },
  /** Clear all transient state (effect cleanup + tests). */
  reset(): void {
    contextMenuFromTouchUntil = 0
    rangeArmed = false
    pinchActive = false
  },
}
