import { describe, it, expect } from 'vitest'
import { dragSnapIsReorder, type SnapTarget } from '@/components/editor/snapTargetAtX'

/**
 * Disambiguation between a horizontal REORDER and a vertical PITCH
 * CHANGE on notehead-drag release.
 *
 * Regression guard for "can't reliably drag a note up/down to change
 * pitch": a straight-down drag keeps the pointer over the notehead
 * center, where snapTargetAtX returns the event's *trailing* boundary
 * (the nearer of its two own edges). The old code matched only the
 * leading boundary, so that trailing snap looked like a reorder and
 * shoved the note sideways. Both own-boundaries must now resolve to a
 * pitch change.
 */

// Source event lives in staff 0, measure 1, spanning 32nds [8, 16)
// (i.e. it's preceded by one quarter note and is itself a quarter).
const SOURCE = {
  staffIdx: 0,
  measureIdx: 1,
  leadingPos32nds: 8,
  trailingPos32nds: 16,
}

function snap(partial: Partial<SnapTarget>): SnapTarget {
  return { staffIdx: 0, measureIdx: 1, position32nds: 8, clientX: 0, clientY: 0, ...partial }
}

describe('dragSnapIsReorder', () => {
  it('treats a missing snap target as a pitch change', () => {
    expect(dragSnapIsReorder(undefined, SOURCE)).toBe(false)
  })

  it('treats a snap on the LEADING boundary as a pitch change', () => {
    expect(dragSnapIsReorder(snap({ position32nds: 8 }), SOURCE)).toBe(false)
  })

  it('treats a snap on the TRAILING boundary as a pitch change (the regressed case)', () => {
    // A pure vertical drag snaps here because the notehead center is
    // nearer its own right edge than the previous note's right edge.
    expect(dragSnapIsReorder(snap({ position32nds: 16 }), SOURCE)).toBe(false)
  })

  it('treats a snap on another beat in the same measure as a reorder', () => {
    expect(dragSnapIsReorder(snap({ position32nds: 24 }), SOURCE)).toBe(true)
    expect(dragSnapIsReorder(snap({ position32nds: 0 }), SOURCE)).toBe(true)
  })

  it('treats a snap in a different measure as a reorder (cross-measure / cross-system)', () => {
    // Even if the offset coincidentally equals a source boundary, a
    // different measure is always a move.
    expect(dragSnapIsReorder(snap({ measureIdx: 2, position32nds: 8 }), SOURCE)).toBe(true)
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 16 }), SOURCE)).toBe(true)
  })

  it('ignores a snap on a different staff (treated as pitch — snap is staff-filtered upstream)', () => {
    expect(dragSnapIsReorder(snap({ staffIdx: 1, position32nds: 24 }), SOURCE)).toBe(false)
  })

  it('handles a first-event source (leading boundary at position 0)', () => {
    const firstEvent = { staffIdx: 0, measureIdx: 0, leadingPos32nds: 0, trailingPos32nds: 8 }
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 0 }), firstEvent)).toBe(false)
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 8 }), firstEvent)).toBe(false)
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 16 }), firstEvent)).toBe(true)
  })

  it('handles a last-event source (trailing boundary at the measure total)', () => {
    const lastEvent = { staffIdx: 0, measureIdx: 0, leadingPos32nds: 24, trailingPos32nds: 32 }
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 32 }), lastEvent)).toBe(false)
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 24 }), lastEvent)).toBe(false)
    expect(dragSnapIsReorder(snap({ measureIdx: 0, position32nds: 16 }), lastEvent)).toBe(true)
  })
})
