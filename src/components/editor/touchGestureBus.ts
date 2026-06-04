/**
 * Tiny module-level bus that decouples the imperative touch-gesture hooks
 * (useScoreContextMenu, useStaffInteractions) without prop-drilling. Holds two
 * pieces of transient cross-hook state:
 *
 *  - a `suppressContextMenu` window — set when a touch long-press has already
 *    handled a gesture, so Android's native `contextmenu` (which ALSO fires on
 *    long-press) doesn't double-open the menu;
 *  - a `rangeArmed` flag — set when a long-press on a bar entered touch
 *    measure-range mode, so subsequent taps extend the range (handled in
 *    useStaffInteractions) instead of placing a note.
 */
let suppressContextMenuUntil = 0
let rangeArmed = false

export const touchGestureBus = {
  /** Open a short window during which a native `contextmenu` should be ignored. */
  suppressContextMenu(ms = 700): void {
    suppressContextMenuUntil = Date.now() + ms
  },
  isContextMenuSuppressed(): boolean {
    return Date.now() < suppressContextMenuUntil
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
  /** Test helper — clear all transient state. */
  reset(): void {
    suppressContextMenuUntil = 0
    rangeArmed = false
  },
}
