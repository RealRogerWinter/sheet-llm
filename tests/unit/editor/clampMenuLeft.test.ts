import { describe, it, expect } from 'vitest'
import { clampMenuLeft } from '@/components/editor/NoteFloatingMenu'

/**
 * SHE-13: the NoteFloatingMenu toolbar used to clamp its `left` against a
 * hardcoded 360px assumed width (`window.innerWidth - 360`), but the real
 * rendered row is much wider, so on a narrow phone the right portion ran off
 * screen. `clampMenuLeft` now clamps against the *measured* menu width so the
 * box always stays within [gutter, vw - gutter].
 */
describe('clampMenuLeft', () => {
  const GUTTER = 8

  it('centers the menu on the anchor when it fits with room to spare', () => {
    // 600px wide menu, 1200px viewport, anchor at center.
    expect(clampMenuLeft(600, 600, 1200, GUTTER)).toBe(300)
  })

  it('keeps a wide menu fully on screen on a narrow viewport (the bug)', () => {
    // Phone: 360px viewport, anchor near the tap point, but a 620px menu.
    const vw = 360
    const menuW = 620
    const ax = 200
    const left = clampMenuLeft(ax, menuW, vw, GUTTER)
    // The old code did `innerWidth - 360` => 360 - 360 = 0, which on a real
    // 620px-wide row leaves the right ~260px off-screen. The clamp must pin
    // the left edge so the box's right edge is at most vw - gutter — but since
    // the menu is wider than the viewport it can't fit, so the left edge pins
    // at the gutter (the strip then scrolls horizontally).
    expect(left).toBe(GUTTER)
    // It must never assume a 360px width: with a 620px menu the old formula
    // would have produced 0, not the gutter.
    expect(left).not.toBe(0)
  })

  it('pins the left edge to the gutter when the anchor is near the left edge', () => {
    expect(clampMenuLeft(10, 300, 1000, GUTTER)).toBe(GUTTER)
  })

  it('pins the right edge inside the gutter when the anchor is near the right edge', () => {
    // vw 1000, menu 300, anchor far right -> right edge can't exceed 1000-8=992
    // so left = 992 - 300 = 692.
    expect(clampMenuLeft(990, 300, 1000, GUTTER)).toBe(692)
  })

  it('never returns less than the gutter', () => {
    expect(clampMenuLeft(0, 5000, 360, GUTTER)).toBeGreaterThanOrEqual(GUTTER)
  })
})
