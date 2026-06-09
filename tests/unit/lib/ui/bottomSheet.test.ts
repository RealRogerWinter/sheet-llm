import { describe, it, expect } from 'vitest'
import {
  resolveSheetDrag,
  clampDragOffset,
  POSITION_THRESHOLD_RATIO,
  VELOCITY_THRESHOLD_PX_PER_MS,
  type SheetState,
} from '@/lib/ui/bottomSheet'

const HEIGHT = 600

// A drag offset is measured from the EXPANDED rest position. Positive =
// dragged DOWNWARD (toward dismiss); negative = dragged UPWARD (sheet is
// already at full height, so upward drag is clamped to 0 — you can't pull
// it taller than its expanded height).

describe('clampDragOffset', () => {
  it('clamps upward (negative) drag to 0 — the sheet cannot exceed its expanded height', () => {
    expect(clampDragOffset(-120, HEIGHT)).toBe(0)
    expect(clampDragOffset(-1, HEIGHT)).toBe(0)
  })

  it('clamps downward drag to at most the sheet height (fully off-screen)', () => {
    expect(clampDragOffset(900, HEIGHT)).toBe(HEIGHT)
    expect(clampDragOffset(HEIGHT, HEIGHT)).toBe(HEIGHT)
  })

  it('passes through an in-range downward offset unchanged', () => {
    expect(clampDragOffset(150, HEIGHT)).toBe(150)
    expect(clampDragOffset(0, HEIGHT)).toBe(0)
  })
})

describe('resolveSheetDrag from expanded', () => {
  const base = { sheetHeightPx: HEIGHT, currentState: 'expanded' as SheetState }

  it('snaps back to expanded on a small downward drag below both thresholds', () => {
    expect(
      resolveSheetDrag({ ...base, dragOffsetPx: 40, velocityPxPerMs: 0.05 }),
    ).toBe('expanded')
  })

  it('dismisses when the downward drag passes the POSITION threshold even at zero velocity', () => {
    const past = HEIGHT * POSITION_THRESHOLD_RATIO + 1
    expect(
      resolveSheetDrag({ ...base, dragOffsetPx: past, velocityPxPerMs: 0 }),
    ).toBe('dismissed')
  })

  it('does NOT dismiss when the downward drag is just below the position threshold (no velocity)', () => {
    const below = HEIGHT * POSITION_THRESHOLD_RATIO - 1
    expect(
      resolveSheetDrag({ ...base, dragOffsetPx: below, velocityPxPerMs: 0 }),
    ).toBe('expanded')
  })

  it('dismisses on a fast downward flick past the VELOCITY threshold even with a tiny offset', () => {
    expect(
      resolveSheetDrag({
        ...base,
        dragOffsetPx: 20,
        velocityPxPerMs: VELOCITY_THRESHOLD_PX_PER_MS + 0.1,
      }),
    ).toBe('dismissed')
  })

  it('does NOT dismiss on a fast UPWARD flick (negative velocity past the threshold)', () => {
    expect(
      resolveSheetDrag({
        ...base,
        dragOffsetPx: 20,
        velocityPxPerMs: -(VELOCITY_THRESHOLD_PX_PER_MS + 0.5),
      }),
    ).toBe('expanded')
  })

  it('treats a velocity exactly AT the threshold as not-yet-committing (strictly greater wins)', () => {
    expect(
      resolveSheetDrag({
        ...base,
        dragOffsetPx: 20,
        velocityPxPerMs: VELOCITY_THRESHOLD_PX_PER_MS,
      }),
    ).toBe('expanded')
  })
})

describe('resolveSheetDrag from collapsed (peek)', () => {
  const base = { sheetHeightPx: HEIGHT, currentState: 'collapsed' as SheetState }

  it('expands on an upward drag past the position threshold (offset measured downward, so negative)', () => {
    const past = -(HEIGHT * POSITION_THRESHOLD_RATIO + 1)
    expect(
      resolveSheetDrag({ ...base, dragOffsetPx: past, velocityPxPerMs: 0 }),
    ).toBe('expanded')
  })

  it('expands on a fast upward flick past the velocity threshold with a small offset', () => {
    expect(
      resolveSheetDrag({
        ...base,
        dragOffsetPx: -20,
        velocityPxPerMs: -(VELOCITY_THRESHOLD_PX_PER_MS + 0.2),
      }),
    ).toBe('expanded')
  })

  it('snaps back to collapsed on a small upward drag below both thresholds', () => {
    expect(
      resolveSheetDrag({ ...base, dragOffsetPx: -30, velocityPxPerMs: -0.05 }),
    ).toBe('collapsed')
  })

  it('dismisses from collapsed on a downward drag past the position threshold', () => {
    const downPast = HEIGHT * POSITION_THRESHOLD_RATIO + 1
    expect(
      resolveSheetDrag({ ...base, dragOffsetPx: downPast, velocityPxPerMs: 0 }),
    ).toBe('dismissed')
  })

  it('dismisses from collapsed on a fast downward flick', () => {
    expect(
      resolveSheetDrag({
        ...base,
        dragOffsetPx: 10,
        velocityPxPerMs: VELOCITY_THRESHOLD_PX_PER_MS + 0.3,
      }),
    ).toBe('dismissed')
  })
})

describe('resolveSheetDrag clamping / degenerate inputs', () => {
  it('never dismisses a zero-height sheet via the position threshold (no division-by-edge surprises)', () => {
    expect(
      resolveSheetDrag({
        sheetHeightPx: 0,
        currentState: 'expanded',
        dragOffsetPx: 5,
        velocityPxPerMs: 0,
      }),
    ).toBe('expanded')
  })

  it('a perfectly still release (no offset, no velocity) keeps the current state', () => {
    expect(
      resolveSheetDrag({
        sheetHeightPx: HEIGHT,
        currentState: 'expanded',
        dragOffsetPx: 0,
        velocityPxPerMs: 0,
      }),
    ).toBe('expanded')
    expect(
      resolveSheetDrag({
        sheetHeightPx: HEIGHT,
        currentState: 'collapsed',
        dragOffsetPx: 0,
        velocityPxPerMs: 0,
      }),
    ).toBe('collapsed')
  })
})
