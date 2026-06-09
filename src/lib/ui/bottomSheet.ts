/**
 * Pure drag→snap decision logic for the mobile chat bottom sheet (SHE-11).
 *
 * The sheet is a tiny state machine with three resting states:
 *   - `collapsed` — a short "peek" strip at the bottom (the open affordance)
 *   - `expanded`  — the full-height conversation panel
 *   - `dismissed` — fully off-screen / closed
 *
 * Drag offset is measured in CSS pixels relative to the sheet's current
 * resting position, with the screen Y axis convention: POSITIVE = dragged
 * DOWNWARD (toward dismiss), NEGATIVE = dragged UPWARD (toward expand).
 * Velocity is in px/ms at release, same sign convention.
 *
 * A release COMMITS to the next state when EITHER the drag travelled past a
 * fraction of the sheet height (position threshold) OR the release flick was
 * faster than the velocity threshold (velocity threshold). Direction decides
 * which neighbouring state we commit to; otherwise the sheet snaps back.
 *
 * Kept framework-free and side-effect-free so it can be unit-tested
 * exhaustively without jsdom/pointer plumbing — the DOM wiring lives in
 * ChatHistoryPanel and merely feeds numbers in and applies the result.
 */

export type SheetState = 'collapsed' | 'expanded' | 'dismissed'

/**
 * Fraction of the sheet height a drag must exceed to commit to the
 * neighbouring state on position alone (velocity below threshold). 0.4 = the
 * standard "past 40% and you've decided" feel used by most native sheets.
 */
export const POSITION_THRESHOLD_RATIO = 0.4

/**
 * Release speed (px/ms) above which a flick commits regardless of how far the
 * sheet travelled. ~0.5px/ms ≈ a deliberate flick, not an accidental nudge.
 * The comparison is STRICTLY greater, so a velocity exactly at the threshold
 * does not commit on its own.
 */
export const VELOCITY_THRESHOLD_PX_PER_MS = 0.5

/**
 * Clamp a raw drag offset to the physically meaningful range. The sheet can't
 * be pulled taller than its expanded height (upward / negative drag clamps to
 * 0) and can't travel further down than fully off-screen (`sheetHeightPx`).
 *
 * NOTE: this clamps for the *render transform* (how far to translate the
 * sheet). The snap DECISION in `resolveSheetDrag` reads the raw, signed
 * offset so it can tell upward intent (negative) from downward (positive)
 * even when the visible translate is clamped to 0.
 */
export function clampDragOffset(dragOffsetPx: number, sheetHeightPx: number): number {
  if (dragOffsetPx < 0) return 0
  if (dragOffsetPx > sheetHeightPx) return sheetHeightPx
  return dragOffsetPx
}

export interface ResolveSheetDragInput {
  /** Signed CSS-px offset from the resting position; +down, -up. */
  dragOffsetPx: number
  /** Signed release velocity in px/ms; +down, -up. */
  velocityPxPerMs: number
  /** Current sheet height in px (the expanded travel distance). */
  sheetHeightPx: number
  /** Resting state the drag started from. */
  currentState: SheetState
}

/**
 * Resolve where a released drag should snap to.
 *
 * Decision per direction:
 *   - DOWNWARD intent (offset past +position-threshold OR a fast downward
 *     flick): commit toward dismiss — `expanded` → `dismissed`,
 *     `collapsed` → `dismissed`.
 *   - UPWARD intent (offset past -position-threshold OR a fast upward flick):
 *     commit toward open — `collapsed` → `expanded`.
 *   - Otherwise: snap back to `currentState`.
 *
 * `dismissed` is terminal here (a dismissed sheet isn't being dragged), so it
 * always resolves to itself.
 */
export function resolveSheetDrag({
  dragOffsetPx,
  velocityPxPerMs,
  sheetHeightPx,
  currentState,
}: ResolveSheetDragInput): SheetState {
  if (currentState === 'dismissed') return 'dismissed'

  const positionThreshold = sheetHeightPx * POSITION_THRESHOLD_RATIO

  // Downward commit: past the position threshold downward, or a fast
  // downward flick. A zero-height sheet has a 0 position threshold; guard so
  // a 0-offset still release doesn't read as "past threshold".
  const draggedDownPastPosition = positionThreshold > 0 && dragOffsetPx >= positionThreshold
  const flickedDown = velocityPxPerMs > VELOCITY_THRESHOLD_PX_PER_MS
  if (draggedDownPastPosition || flickedDown) {
    return 'dismissed'
  }

  // Upward commit only matters from collapsed (expanded is already at full
  // height — upward drag is clamped and there's nothing taller to go to).
  if (currentState === 'collapsed') {
    const draggedUpPastPosition =
      positionThreshold > 0 && dragOffsetPx <= -positionThreshold
    const flickedUp = velocityPxPerMs < -VELOCITY_THRESHOLD_PX_PER_MS
    if (draggedUpPastPosition || flickedUp) {
      return 'expanded'
    }
  }

  return currentState
}
