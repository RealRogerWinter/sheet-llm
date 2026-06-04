import { describe, it, expect } from 'vitest'
import { pickBandByY, pickSystemByGutter, resolveStaffFromY } from '@/components/editor/staffResolver'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Build a synthetic abcjs-shaped SVG. `layout` describes the bands
 * each system/staff occupies in client coordinates. We then patch
 * each element's `getBoundingClientRect` to return its declared band,
 * since jsdom returns zeros for SVG layout. This mirrors the pattern
 * used by `staffGeometry.test.ts`.
 */
function buildSvg(
  layout: ReadonlyArray<ReadonlyArray<{ top: number; bottom: number }>>,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  const totalBottom = Math.max(
    ...layout.flat().map((b) => b.bottom),
  )
  svg.setAttribute('viewBox', `0 0 200 ${totalBottom + 10}`)
  shimRect(svg, { left: 0, top: 0, right: 200, bottom: totalBottom + 10 })
  layout.forEach((systemBands, sysIdx) => {
    const wrapper = document.createElementNS(SVG_NS, 'g')
    wrapper.setAttribute('class', `abcjs-staff-wrapper abcjs-l${sysIdx}`)
    const sysTop = Math.min(...systemBands.map((b) => b.top))
    const sysBot = Math.max(...systemBands.map((b) => b.bottom))
    shimRect(wrapper, { left: 0, top: sysTop, right: 200, bottom: sysBot })
    systemBands.forEach((band) => {
      const staff = document.createElementNS(SVG_NS, 'g')
      staff.setAttribute('class', 'abcjs-staff')
      shimRect(staff, { left: 0, top: band.top, right: 200, bottom: band.bottom })
      // Add five line paths so getStaffYPositionsFor would work too.
      const step = (band.bottom - band.top) / 4
      for (let i = 0; i < 5; i++) {
        const p = document.createElementNS(SVG_NS, 'path')
        p.setAttribute('d', `M0 ${band.top + i * step} L200 ${band.top + i * step}`)
        staff.appendChild(p)
      }
      wrapper.appendChild(staff)
    })
    svg.appendChild(wrapper)
  })
  return svg
}

function shimRect(
  el: Element,
  r: { left: number; top: number; right: number; bottom: number },
): void {
  ;(el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      ...r,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
      toJSON() {
        return {}
      },
    }) as DOMRect
}

describe('pickBandByY', () => {
  it('returns the element whose band contains the click', () => {
    const bands = [
      { el: 'a', top: 0, bottom: 10 },
      { el: 'b', top: 20, bottom: 30 },
    ]
    expect(pickBandByY(bands, 25)).toBe('b')
  })
  it('falls back to nearest center when no band contains the click', () => {
    const bands = [
      { el: 'a', top: 0, bottom: 10 },   // center 5
      { el: 'b', top: 20, bottom: 30 },  // center 25
    ]
    // Tie is at click=15 (equal distance to both centers).
    expect(pickBandByY(bands, 14)).toBe('a')
    expect(pickBandByY(bands, 16)).toBe('b')
  })
  it('returns undefined for an empty list', () => {
    expect(pickBandByY([], 0)).toBeUndefined()
  })
})

describe('resolveStaffFromY — single-staff, single-system', () => {
  it('returns logical staff 0 for any click', () => {
    const svg = buildSvg([[{ top: 10, bottom: 30 }]])
    expect(resolveStaffFromY(svg, 20, 1)?.staffIdx).toBe(0)
    expect(resolveStaffFromY(svg, 0, 1)?.staffIdx).toBe(0)
    expect(resolveStaffFromY(svg, 100, 1)?.staffIdx).toBe(0)
  })
})

describe('resolveStaffFromY — grand staff, single system', () => {
  it('routes treble-band clicks to staff 0', () => {
    const svg = buildSvg([[
      { top: 10, bottom: 30 },   // treble
      { top: 50, bottom: 70 },   // bass
    ]])
    expect(resolveStaffFromY(svg, 20, 2)?.staffIdx).toBe(0)
  })
  it('routes bass-band clicks to staff 1', () => {
    const svg = buildSvg([[
      { top: 10, bottom: 30 },
      { top: 50, bottom: 70 },
    ]])
    expect(resolveStaffFromY(svg, 60, 2)?.staffIdx).toBe(1)
  })
  it('routes inter-staff gap clicks to the nearest staff', () => {
    const svg = buildSvg([[
      { top: 10, bottom: 30 },   // center 20
      { top: 50, bottom: 70 },   // center 60
    ]])
    // gap midpoint is 40; closer to treble center (20→40=20) vs bass (60→40=20)
    // tie-breaks to first (treble); 41 leans bass.
    expect(resolveStaffFromY(svg, 41, 2)?.staffIdx).toBe(1)
    expect(resolveStaffFromY(svg, 39, 2)?.staffIdx).toBe(0)
  })
})

describe('resolveStaffFromY — grand staff, multiple systems (the bug)', () => {
  /**
   * Two systems × two staves = four `.abcjs-staff` DOM elements at
   * indices 0..3. The legacy `staffIdxFromY` returned the DOM index,
   * so a bass-clef click on system 1 returned 3 and any downstream
   * `getStaffClef(score, 3)` silently fell back to treble — the
   * canonical symptom of "can't place notes on bass on multi-line
   * scores". The resolver must return logical 1 for both systems.
   */
  it('routes bass clicks to logical staff 1 on system 0', () => {
    const svg = buildSvg([
      [{ top: 10, bottom: 30 }, { top: 50, bottom: 70 }],
      [{ top: 100, bottom: 120 }, { top: 140, bottom: 160 }],
    ])
    expect(resolveStaffFromY(svg, 60, 2)?.staffIdx).toBe(1)
  })
  it('routes bass clicks to logical staff 1 on system 1', () => {
    const svg = buildSvg([
      [{ top: 10, bottom: 30 }, { top: 50, bottom: 70 }],
      [{ top: 100, bottom: 120 }, { top: 140, bottom: 160 }],
    ])
    expect(resolveStaffFromY(svg, 150, 2)?.staffIdx).toBe(1)
  })
  it('routes treble clicks to logical staff 0 on system 1', () => {
    const svg = buildSvg([
      [{ top: 10, bottom: 30 }, { top: 50, bottom: 70 }],
      [{ top: 100, bottom: 120 }, { top: 140, bottom: 160 }],
    ])
    expect(resolveStaffFromY(svg, 110, 2)?.staffIdx).toBe(0)
  })
  it('returns the staff element from the CLICKED system, not system 0', () => {
    const svg = buildSvg([
      [{ top: 10, bottom: 30 }, { top: 50, bottom: 70 }],
      [{ top: 100, bottom: 120 }, { top: 140, bottom: 160 }],
    ])
    const sys1Bass = resolveStaffFromY(svg, 150, 2)
    expect(sys1Bass).toBeDefined()
    expect(sys1Bass!.staffEl.getBoundingClientRect().top).toBe(140)
  })
})

describe('resolveStaffFromY — legacy fallback (no wrappers)', () => {
  it('still groups by parent when .abcjs-staff-wrapper is absent', () => {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    shimRect(svg, { left: 0, top: 0, right: 200, bottom: 200 })
    const lineGroup = document.createElementNS(SVG_NS, 'g')
    shimRect(lineGroup, { left: 0, top: 0, right: 200, bottom: 100 })
    for (const band of [
      { top: 10, bottom: 30 },
      { top: 50, bottom: 70 },
    ]) {
      const staff = document.createElementNS(SVG_NS, 'g')
      staff.setAttribute('class', 'abcjs-staff')
      shimRect(staff, { left: 0, top: band.top, right: 200, bottom: band.bottom })
      lineGroup.appendChild(staff)
    }
    svg.appendChild(lineGroup)
    expect(resolveStaffFromY(svg, 60, 2)?.staffIdx).toBe(1)
  })
})

describe('resolveStaffFromY — empty SVG', () => {
  it('returns undefined when no .abcjs-staff elements are present', () => {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    expect(resolveStaffFromY(svg, 100, 2)).toBeUndefined()
  })
})

describe('resolveStaffFromY — clamps to staffCount', () => {
  it("doesn't return a staffIdx >= staffCount even if DOM has more groups", () => {
    // Simulate an oddly-rendered system with 3 .abcjs-staff inside
    // (e.g. a future feature or a tab staff). With staffCount=2 we
    // never report a logical index of 2.
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    shimRect(svg, { left: 0, top: 0, right: 200, bottom: 200 })
    const wrap = document.createElementNS(SVG_NS, 'g')
    wrap.setAttribute('class', 'abcjs-staff-wrapper abcjs-l0')
    shimRect(wrap, { left: 0, top: 0, right: 200, bottom: 150 })
    for (const band of [
      { top: 10, bottom: 30 },
      { top: 50, bottom: 70 },
      { top: 100, bottom: 120 },
    ]) {
      const staff = document.createElementNS(SVG_NS, 'g')
      staff.setAttribute('class', 'abcjs-staff')
      shimRect(staff, { left: 0, top: band.top, right: 200, bottom: band.bottom })
      wrap.appendChild(staff)
    }
    svg.appendChild(wrap)
    expect(resolveStaffFromY(svg, 110, 2)?.staffIdx).toBe(1)
  })
})

describe('pickSystemByGutter', () => {
  it('returns undefined for an empty list', () => {
    expect(pickSystemByGutter([], 0)).toBeUndefined()
  })
  it('returns the sole element for a single-system list at any Y (single-system no-op)', () => {
    const one = [{ el: 'only', top: 10, bottom: 30 }]
    expect(pickSystemByGutter(one, 20)).toBe('only') // inside
    expect(pickSystemByGutter(one, -100)).toBe('only') // far above
    expect(pickSystemByGutter(one, 999)).toBe('only') // far below
  })
  it('containment wins (a click inside a band returns that band)', () => {
    const bands = [
      { el: 'a', top: 0, bottom: 40 },
      { el: 'b', top: 50, bottom: 60 },
    ]
    expect(pickSystemByGutter(bands, 39)).toBe('a')
    expect(pickSystemByGutter(bands, 55)).toBe('b')
  })
  it('splits a symmetric gutter at the midline', () => {
    const bands = [
      { el: 'a', top: 0, bottom: 10 },
      { el: 'b', top: 30, bottom: 40 },
    ]
    // gutter 10..30, midline 20 (inclusive to the upper system)
    expect(pickSystemByGutter(bands, 19)).toBe('a')
    expect(pickSystemByGutter(bands, 20)).toBe('a')
    expect(pickSystemByGutter(bands, 21)).toBe('b')
  })
  it('splits an ASYMMETRIC gutter at the midline, not the nearest center', () => {
    const bands = [
      { el: 'a', top: 0, bottom: 40 }, // center 20
      { el: 'b', top: 60, bottom: 70 }, // center 65
    ]
    // gutter 40..60, midline 50. Nearest-CENTER would hand Y=49 to b
    // (|49-65|=16 < |49-20|=29); the midline correctly gives a.
    expect(pickSystemByGutter(bands, 49)).toBe('a')
    expect(pickSystemByGutter(bands, 51)).toBe('b')
  })
  it('clamps above the first system and below the last', () => {
    const bands = [
      { el: 'a', top: 10, bottom: 20 },
      { el: 'b', top: 40, bottom: 50 },
    ]
    expect(pickSystemByGutter(bands, 0)).toBe('a') // above first
    expect(pickSystemByGutter(bands, 100)).toBe('b') // below last
  })
  it('sorts unsorted input internally (order-independent)', () => {
    const bands = [
      { el: 'b', top: 30, bottom: 40 }, // deliberately lower-first
      { el: 'a', top: 0, bottom: 10 },
    ]
    expect(pickSystemByGutter(bands, 5)).toBe('a') // inside a
    expect(pickSystemByGutter(bands, 19)).toBe('a') // gutter, above midline 20
    expect(pickSystemByGutter(bands, 21)).toBe('b') // gutter, below midline
  })
})

describe('resolveStaffFromY — inter-system gutter ownership (regression for wrong-system high-note clicks)', () => {
  // ASYMMETRIC system heights so the gutter midline DIVERGES from the old
  // nearest-band-center pick — this is what makes the Y=85 case fail before
  // the fix and pass after. sys0 union [0,80] (center 40, tall); sys1 union
  // [100,120] (center 110, short). Empty gutter is 80..100, midline 90; the
  // center-midpoint is only 75. abcjs draws `.abcjs-staff` lines-only, so a
  // high note sticking above sys1 lands in this gutter.
  const layout = [
    [{ top: 0, bottom: 30 }, { top: 50, bottom: 80 }],
    [{ top: 100, bottom: 110 }, { top: 114, bottom: 120 }],
  ]

  it('a gutter click nearer the upper system edge resolves to the upper system (fails pre-fix)', () => {
    const svg = buildSvg(layout)
    // Y=85: in the gutter, 5px below sys0 but nearer sys1's CENTER. The old
    // nearest-center pick chose sys1 (wrong, top 100/114); the midline picks
    // sys0 (top 0/50).
    const r = resolveStaffFromY(svg, 85, 2)
    expect(r).toBeDefined()
    expect([0, 50]).toContain(r!.staffEl.getBoundingClientRect().top)
  })

  it('a gutter click past the midline resolves to the lower system', () => {
    const svg = buildSvg(layout)
    const r = resolveStaffFromY(svg, 95, 2) // 95 > midline 90
    expect(r).toBeDefined()
    expect([100, 114]).toContain(r!.staffEl.getBoundingClientRect().top)
  })

  it('clicks above the whole score clamp to the first system', () => {
    const svg = buildSvg(layout)
    const r = resolveStaffFromY(svg, -20, 2)
    expect(r).toBeDefined()
    expect([0, 50]).toContain(r!.staffEl.getBoundingClientRect().top)
  })

  it('clicks below the whole score clamp to the last system', () => {
    const svg = buildSvg(layout)
    const r = resolveStaffFromY(svg, 300, 2)
    expect(r).toBeDefined()
    expect([100, 114]).toContain(r!.staffEl.getBoundingClientRect().top)
  })
})
