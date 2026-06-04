import { describe, it, expect } from 'vitest'
import {
  extractPathDs,
  extractSvgSize,
  walkPath,
  pathDistance,
} from '../../../evals/lib/svgPathDistance'

describe('extractPathDs', () => {
  it('returns d="..." values in document order', () => {
    const svg = `<svg><path d="M0 0 L10 0"/><g><path d="M5 5"/></g></svg>`
    expect(extractPathDs(svg)).toEqual(['M0 0 L10 0', 'M5 5'])
  })

  it('handles single quotes', () => {
    const svg = `<svg><path d='M0 0'/></svg>`
    expect(extractPathDs(svg)).toEqual(['M0 0'])
  })

  it('ignores other attributes between path and d', () => {
    const svg = `<svg><path stroke="black" stroke-width="2" d="M1 2 L3 4" fill="none"/></svg>`
    expect(extractPathDs(svg)).toEqual(['M1 2 L3 4'])
  })

  it('returns empty array when no paths', () => {
    expect(extractPathDs('<svg></svg>')).toEqual([])
  })
})

describe('extractSvgSize', () => {
  it('reads viewBox', () => {
    const svg = `<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`
    expect(extractSvgSize(svg)).toEqual({ width: 800, height: 600 })
  })

  it('reads viewBox with comma separators and offset origin', () => {
    const svg = `<svg viewBox="10,20,400,300"><path d="M0 0"/></svg>`
    expect(extractSvgSize(svg)).toEqual({ width: 400, height: 300 })
  })

  it('falls back to width/height attrs when no viewBox', () => {
    const svg = `<svg width="500" height="250"><path d="M0 0"/></svg>`
    expect(extractSvgSize(svg)).toEqual({ width: 500, height: 250 })
  })

  it('returns null when neither viewBox nor width/height present', () => {
    expect(extractSvgSize('<svg><path d="M0 0"/></svg>')).toBeNull()
  })

  it('returns null for malformed viewBox', () => {
    expect(extractSvgSize('<svg viewBox="not numbers"><path d="M0 0"/></svg>')).toBeNull()
  })
})

describe('walkPath', () => {
  it('walks absolute M+L commands', () => {
    expect(walkPath('M0 0 L10 0 L10 10')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
  })

  it('walks relative m+l commands', () => {
    expect(walkPath('m0 0 l10 0 l0 10')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
  })

  it('M with multiple implicit-L coord pairs', () => {
    expect(walkPath('M0 0 10 0 20 0')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ])
  })

  it('cubic-curve endpoints', () => {
    // M0,0 C10,0 10,10 20,10
    expect(walkPath('M0 0 C10 0 10 10 20 10')).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 10 },
    ])
  })

  it('Z returns to start', () => {
    const pts = walkPath('M5 5 L10 5 L10 10 Z')
    expect(pts.at(-1)).toEqual({ x: 5, y: 5 })
  })

  it('horizontal/vertical commands', () => {
    expect(walkPath('M0 0 H10 V5 h5 v5')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 10 },
    ])
  })

  it('implicit-sign coords like 1.5-2', () => {
    expect(walkPath('M0 0 l1.5-2')).toEqual([
      { x: 0, y: 0 },
      { x: 1.5, y: -2 },
    ])
  })

  it('scientific-notation coords (lock down number parser)', () => {
    // The path-command regex must NOT match the `e` inside a scientific-
    // notation literal as a path command. `1.5e-3` is a single number,
    // not a command 'e' with args. The current cmdRe character class
    // intentionally excludes e/E for this reason; this test locks it.
    expect(walkPath('M1.5e-3 2 L1e2 5e-1')).toEqual([
      { x: 0.0015, y: 2 },
      { x: 100, y: 0.5 },
    ])
  })
})

describe('pathDistance', () => {
  it('identical SVGs → metric 0', () => {
    const svg = `<svg><path d="M0 0 L100 0 L100 100 L0 100 Z"/></svg>`
    const r = pathDistance(svg, svg)
    expect(r.metric).toBe(0)
    expect(r.pathsA).toBe(1)
    expect(r.pathsB).toBe(1)
  })

  it('one path shifted right by 50px → non-trivial metric (above 0.02 threshold)', () => {
    // Synthetic SVGs without viewBox fall through to raw-pixel space
    // (per the size=1 fallback), so a 50px shift on a 100-unit square
    // is large. The point is: a non-trivial shift produces a metric
    // well above the 0.02 visual-eval threshold — which is the
    // correct behaviour for "real" drift.
    const a = `<svg><path d="M0 0 L100 0 L100 100 L0 100 Z"/></svg>`
    const b = `<svg><path d="M50 0 L150 0 L150 100 L50 100 Z"/></svg>`
    const r = pathDistance(a, b)
    expect(r.metric).toBeGreaterThan(0.02)
    expect(r.metric).toBeLessThan(1)
  })

  it('one path shifted 50px on a viewBox=800x600 baseline → non-trivial metric above 0.02', () => {
    // With viewBox-relative normalization: each x-vertex shifts by
    // 50/800 ≈ 0.0625 in normalized space. The full metric (delta
    // over normalized-perimeter) ends up well above the 0.02
    // visual-eval threshold — which is the right behaviour for a
    // "non-trivial shift". The exact value depends on
    // path/perimeter geometry; the key invariant is "well above
    // threshold, well under 1".
    const a = `<svg viewBox="0 0 800 600"><path d="M0 0 L100 0 L100 100 L0 100 Z"/></svg>`
    const b = `<svg viewBox="0 0 800 600"><path d="M50 0 L150 0 L150 100 L50 100 Z"/></svg>`
    const r = pathDistance(a, b)
    expect(r.metric).toBeGreaterThan(0.02)
    expect(r.metric).toBeLessThan(1)
  })

  it('identical paths rendered at different overall sizes → still near-zero (normalization works)', () => {
    // Same shape filling the full viewBox in each case. Without
    // normalization the metric would saturate; with normalization
    // the two paths occupy identical [0,1] coords and score 0.
    const a = `<svg viewBox="0 0 100 100"><path d="M0 0 L100 0 L100 100 L0 100 Z"/></svg>`
    const b = `<svg viewBox="0 0 1000 1000"><path d="M0 0 L1000 0 L1000 1000 L0 1000 Z"/></svg>`
    const r = pathDistance(a, b)
    expect(r.metric).toBe(0)
  })

  it('one tiny offset → small metric (well below 0.02 threshold)', () => {
    // 1px offset on a 1000-unit path with no viewBox (raw-pixel space):
    // small metric. Locks the floor-of-jitter behaviour.
    const a = `<svg><path d="M0 0 L1000 0"/></svg>`
    const b = `<svg><path d="M0 0 L1000 1"/></svg>`
    const r = pathDistance(a, b)
    expect(r.metric).toBeLessThan(0.02)
  })

  it('completely disjoint structure → metric near 1', () => {
    const a = `<svg><path d="M0 0 L1 0"/></svg>`
    const b = `<svg><path d="M1000 1000 L1001 1000"/></svg>`
    const r = pathDistance(a, b)
    // ~1414 units of delta, ~1 unit of normalizer → clamps to 1.
    expect(r.metric).toBe(1)
  })

  it('different path counts contribute fully to drift', () => {
    const a = `<svg><path d="M0 0 L10 0"/></svg>`
    const b = `<svg><path d="M0 0 L10 0"/><path d="M20 20 L30 20"/></svg>`
    const r = pathDistance(a, b)
    // First pair identical (delta 0). The extra path contributes
    // its full length to both delta and normalizer → metric > 0.
    expect(r.metric).toBeGreaterThan(0)
    expect(r.pathsA).toBe(1)
    expect(r.pathsB).toBe(2)
  })

  it('empty SVGs on both sides → metric 0', () => {
    const r = pathDistance('<svg></svg>', '<svg></svg>')
    expect(r.metric).toBe(0)
  })

  it('empty vs non-empty → metric 1', () => {
    const r = pathDistance('<svg></svg>', '<svg><path d="M0 0 L10 0"/></svg>')
    expect(r.metric).toBe(1)
  })
})
