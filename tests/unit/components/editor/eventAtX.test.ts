import { describe, it, expect, beforeEach } from 'vitest'
import { eventAtX } from '@/components/editor/eventAtX'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'

/** Build a SourceMap with one event per (startChar, m, e) triple.
 *  Entries MUST be in ascending startChar order — resolveClickPosition
 *  binary-searches the events array. */
function buildMap(entries: Array<{ startChar: number; m: number; e: number; width?: number }>): SourceMap {
  const events = entries.map(({ startChar, m, e, width = 2 }) => ({
    staffIdx: 0,
    voiceIdx: 0,
    measureIdx: m,
    eventIdx: e,
    startChar,
    endChar: startChar + width,
    pitchRanges: [
      { staffIdx: 0, voiceIdx: 0, measureIdx: m, eventIdx: e, pitchIdx: 0, startChar, endChar: startChar + 1 },
    ],
  }))
  const byEvent = new Map<string, (typeof events)[number]>()
  for (const r of events) byEvent.set(`${r.staffIdx}:${r.voiceIdx}:${r.measureIdx}:${r.eventIdx}`, r)
  return { events, byEvent }
}

/** Append a data-startchar node with a mocked bounding-box to `parent`. */
function addNoteNodeTo(parent: Element, startChar: number, left: number, right: number) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  node.setAttribute('data-startchar', String(startChar))
  // jsdom's getBoundingClientRect returns a zero rect by default — stub it.
  Object.defineProperty(node, 'getBoundingClientRect', {
    value: () => ({
      left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0,
      toJSON() { return {} },
    }),
  })
  parent.appendChild(node)
}

/** Append a data-startchar node directly under `svg` (single-system). */
function addNoteNode(svg: SVGSVGElement, startChar: number, left: number, right: number) {
  addNoteNodeTo(svg, startChar, left, right)
}

/** Create an `.abcjs-staff-wrapper` <g> (one rendered system) under svg. */
function addSystem(svg: SVGSVGElement): SVGGElement {
  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement
  wrapper.setAttribute('class', 'abcjs-staff-wrapper')
  svg.appendChild(wrapper)
  return wrapper
}

describe('eventAtX', () => {
  let svg: SVGSVGElement

  beforeEach(() => {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
    document.body.appendChild(svg)
  })

  it('returns the event whose X-band contains the click', () => {
    addNoteNode(svg, 10, 50, 80)
    addNoteNode(svg, 14, 100, 130)
    const map = buildMap([
      { startChar: 10, m: 0, e: 0 },
      { startChar: 14, m: 0, e: 1 },
    ])
    expect(eventAtX(svg, 65, map, svg)).toEqual({ staffIdx: 0, measureIdx: 0, eventIdx: 0 })  // eventAtX only returns staff/measure/event
    expect(eventAtX(svg, 115, map, svg)).toEqual({ staffIdx: 0, measureIdx: 0, eventIdx: 1 })
  })

  it('returns undefined when the click falls in a gap', () => {
    addNoteNode(svg, 10, 50, 80)
    addNoteNode(svg, 14, 100, 130)
    const map = buildMap([
      { startChar: 10, m: 0, e: 0 },
      { startChar: 14, m: 0, e: 1 },
    ])
    expect(eventAtX(svg, 90, map, svg)).toBeUndefined()
  })

  it('returns undefined when there are no note nodes', () => {
    const map = buildMap([{ startChar: 10, m: 0, e: 0 }])
    expect(eventAtX(svg, 50, map, svg)).toBeUndefined()
  })

  it('skips nodes whose data-startchar is unmappable', () => {
    addNoteNode(svg, 99, 50, 80) // not in map
    addNoteNode(svg, 14, 100, 130)
    const map = buildMap([{ startChar: 14, m: 1, e: 0 }])
    expect(eventAtX(svg, 65, map, svg)).toBeUndefined()
    expect(eventAtX(svg, 115, map, svg)).toEqual({ staffIdx: 0, measureIdx: 1, eventIdx: 0 })
  })

  it('ignores zero-width nodes (off-screen or unrendered)', () => {
    addNoteNode(svg, 10, 50, 50) // zero width
    addNoteNode(svg, 14, 100, 130)
    const map = buildMap([
      { startChar: 10, m: 0, e: 0 },
      { startChar: 14, m: 0, e: 1 },
    ])
    expect(eventAtX(svg, 50, map, svg)).toBeUndefined()
    expect(eventAtX(svg, 115, map, svg)).toEqual({ staffIdx: 0, measureIdx: 0, eventIdx: 1 })
  })
})

describe('eventAtX — multi-system scoping (regression for wrong-line implicit-merge)', () => {
  // Two rendered systems, each its own `.abcjs-staff-wrapper`, both with a
  // treble (logical staff 0) chord. System 0's chord sits at X-band
  // [60,90]; system 1's chord at [100,120]. The reported bug: an
  // empty-space click at X=110 in the UPPER system (system 0, which has no
  // notehead there) implicit-merged into the LOWER system's chord because
  // eventAtX scanned the whole SVG and matched by X + logical staff only.
  function buildTwoSystems() {
    const localSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
    document.body.appendChild(localSvg)
    const sys0 = addSystem(localSvg)
    const sys1 = addSystem(localSvg)
    addNoteNodeTo(sys0, 10, 60, 90) // system 0 treble chord
    addNoteNodeTo(sys1, 400, 100, 120) // system 1 treble chord (same logical staff 0)
    // Ascending startChar order for the binary search in resolveClickPosition.
    const map = buildMap([
      { startChar: 10, m: 0, e: 0 },
      { startChar: 400, m: 5, e: 0 },
    ])
    return { localSvg, sys0, sys1, map }
  }

  it('documents the pre-fix bug: scanning the whole SVG reaches the lower system', () => {
    const { localSvg, map } = buildTwoSystems()
    // Passing the whole svg as the scope reproduces the old behavior: the
    // click at X=110 (no note there in system 0) matches system 1's chord.
    // This also proves the lower-system node is reachable, so the scoped
    // "returns undefined" assertion below is not vacuous.
    expect(eventAtX(localSvg, 110, map, localSvg, 0)).toEqual({
      staffIdx: 0,
      measureIdx: 5,
      eventIdx: 0,
    })
  })

  it('scoping to the clicked (upper) system returns undefined → caller falls through to insert', () => {
    const { localSvg, sys0, map } = buildTwoSystems()
    // THE FIX: no chord overlaps X=110 within the clicked system, so no
    // implicit-merge target is found and the caller runs the insert path
    // instead. Also pins the deliberate ABSENCE of an svg-wide fallback — a
    // future fallback would resurrect the cross-system merge.
    expect(eventAtX(localSvg, 110, map, sys0, 0)).toBeUndefined()
  })

  it('scoping to the system that DOES contain the chord still finds it (no over-filtering)', () => {
    const { localSvg, sys1, map } = buildTwoSystems()
    expect(eventAtX(localSvg, 110, map, sys1, 0)).toEqual({
      staffIdx: 0,
      measureIdx: 5,
      eventIdx: 0,
    })
  })

  it('a click that lands on the upper system chord merges into the upper system', () => {
    const { localSvg, sys0, map } = buildTwoSystems()
    // X=75 is inside system 0's treble band [60,90]. Guards against a future
    // bug that leaves the upper wrapper empty (which would make the
    // "returns undefined" assertion above pass vacuously).
    expect(eventAtX(localSvg, 75, map, sys0, 0)).toEqual({
      staffIdx: 0,
      measureIdx: 0,
      eventIdx: 0,
    })
  })
})
