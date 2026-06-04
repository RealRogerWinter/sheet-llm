import { describe, it, expect, beforeEach } from 'vitest'
import { renderScore } from '@/lib/abc/synth'

const C_MAJOR_SCALE = 'X:1\nT:C major\nM:4/4\nL:1/8\nK:C\nCDEF GABc|'

describe('renderScore — responsive layout & staffwidth zoom', () => {
  let target: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  it('renders an SVG with no options', async () => {
    await renderScore(target, C_MAJOR_SCALE)
    expect(target.querySelector('svg')).not.toBeNull()
  })

  it('default render is responsive (viewBox, no explicit width attr)', async () => {
    // The baseline contract: a viewBox-sized SVG that reflows to its
    // container, NOT a hard-coded pixel width that wouldn't fit.
    await renderScore(target, C_MAJOR_SCALE)
    const svg = target.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).not.toBeNull()
    expect(svg.getAttribute('width')).toBeNull()
  })

  it('staffwidth (zoom-in) STAYS responsive — no fixed pixel width', async () => {
    // Regression guard for the old zoom: it set abcjs `scale`, which
    // forced abcjs to drop responsive and emit a fixed-width SVG that
    // overflowed the container horizontally. Zoom now drives
    // `staffwidth` while staying responsive, so the SVG keeps a viewBox
    // and NO width attribute at any zoom — it always fits the container
    // width (the score grows downward instead of scrolling sideways).
    await renderScore(target, C_MAJOR_SCALE, { staffwidth: 370 }) // ≈ zoom 2.0
    const svg = target.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).not.toBeNull()
    expect(svg.getAttribute('width')).toBeNull()
  })

  it('wide staffwidth (zoom-out) is also responsive', async () => {
    await renderScore(target, C_MAJOR_SCALE, { staffwidth: 1480 }) // ≈ zoom 0.5
    const svg = target.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).not.toBeNull()
    expect(svg.getAttribute('width')).toBeNull()
  })

  it('renders cleanly with an empty options object', async () => {
    await renderScore(target, C_MAJOR_SCALE, {})
    expect(target.querySelector('svg')).not.toBeNull()
  })
})
