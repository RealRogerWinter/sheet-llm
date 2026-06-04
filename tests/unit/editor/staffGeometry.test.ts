import { describe, it, expect } from 'vitest'
import { pitchFromY } from '@/components/editor/staffGeometry'

/**
 * Build a synthetic SVG with five staff lines at known Y positions so
 * pitchFromY can be tested without a real abcjs render.
 */
function makeStaffSvg(): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('width', '100')
  svg.setAttribute('height', '100')
  const staff = document.createElementNS(svgNs, 'g')
  staff.setAttribute('class', 'abcjs-staff')
  // Lines at y = 10, 20, 30, 40, 50 — top to bottom; step height = 5.
  for (const y of [10, 20, 30, 40, 50]) {
    const path = document.createElementNS(svgNs, 'path')
    path.setAttribute('d', `M0 ${y} L100 ${y}`)
    staff.appendChild(path)
  }
  svg.appendChild(staff)
  // Manually shim getBoundingClientRect — jsdom returns zeros for SVG.
  ;(svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON() {
        return {}
      },
    }) as DOMRect
  return svg
}

describe('pitchFromY — treble clef', () => {
  it('top line (y=10) → F5', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 10, 'treble')).toEqual({ step: 'F', octave: 5 })
  })
  it('middle line (y=30) → B4', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 30, 'treble')).toEqual({ step: 'B', octave: 4 })
  })
  it('bottom line (y=50) → E4', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 50, 'treble')).toEqual({ step: 'E', octave: 4 })
  })
})

describe('pitchFromY — bass clef', () => {
  it('top line (y=10) → A3', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 10, 'bass')).toEqual({ step: 'A', octave: 3 })
  })
  it('middle line (y=30) → D3', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 30, 'bass')).toEqual({ step: 'D', octave: 3 })
  })
  it('bottom line (y=50) → G2', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 50, 'bass')).toEqual({ step: 'G', octave: 2 })
  })
  it('clamps deep below-staff clicks to lowest schema-legal pitch', () => {
    const svg = makeStaffSvg()
    // Y way below the staff (off the ladder) should clamp to D2 (the
    // lowest valid octave for our schema).
    const result = pitchFromY(svg, 200, 'bass')
    expect(result).toEqual({ step: 'D', octave: 2 })
  })
})

describe('pitchFromY — defaults to treble', () => {
  it('omitting clef parameter behaves as treble', () => {
    const svg = makeStaffSvg()
    expect(pitchFromY(svg, 10)).toEqual({ step: 'F', octave: 5 })
  })
})
