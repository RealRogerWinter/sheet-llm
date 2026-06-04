import { describe, it, expect, beforeEach } from 'vitest'
import { classifyContextTarget } from '@/components/editor/contextTarget'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

const NS = 'http://www.w3.org/2000/svg'

type Rect = { left: number; right: number; top: number; bottom: number }

function stubRect(el: Element, r: Rect) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
      toJSON() {
        return {}
      },
    }),
  })
}

function makeG(className: string, opts: { startChar?: number; rect?: Rect } = {}): SVGGElement {
  const g = document.createElementNS(NS, 'g') as SVGGElement
  g.setAttribute('class', className)
  if (opts.startChar !== undefined) g.setAttribute('data-startchar', String(opts.startChar))
  if (opts.rect) stubRect(g, opts.rect)
  return g
}

/** SourceMap whose events are ascending by startChar (resolveClickPosition
 *  binary-searches). Each entry gets a single-pitch range unless `pitches`
 *  is supplied (chord). */
function buildMap(
  entries: Array<{ startChar: number; m: number; e: number; pitches?: number; width?: number }>,
): SourceMap {
  const events = entries.map(({ startChar, m, e, pitches = 1, width = 2 }) => ({
    staffIdx: 0,
    voiceIdx: 0,
    measureIdx: m,
    eventIdx: e,
    startChar,
    endChar: startChar + width,
    pitchRanges: Array.from({ length: pitches }, (_, p) => ({
      staffIdx: 0,
      voiceIdx: 0,
      measureIdx: m,
      eventIdx: e,
      pitchIdx: p,
      startChar: startChar + p,
      endChar: startChar + p + 1,
    })),
  }))
  const byEvent = new Map<string, (typeof events)[number]>()
  for (const r of events) byEvent.set(`${r.staffIdx}:${r.voiceIdx}:${r.measureIdx}:${r.eventIdx}`, r)
  return { events, byEvent }
}

const note = (step: string, octave: number) => ({ pitches: [{ step, octave }], duration: 'quarter' })
const rest = () => ({ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' })
const chord = () => ({
  pitches: [
    { step: 'C', octave: 4 },
    { step: 'E', octave: 4 },
    { step: 'G', octave: 4 },
  ],
  duration: 'quarter',
})

/**
 * One rendered system, one treble staff, three events in measure 0
 * (note / rest / chord) and one note in measure 1. Staff band is
 * [top=0,bottom=100]; every click uses clientY=50 (on the staff).
 */
function buildScene() {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  document.body.appendChild(svg)

  const system = makeG('abcjs-staff-wrapper')
  svg.appendChild(system)

  const staff = makeG('abcjs-staff', { rect: { left: 0, right: 400, top: 0, bottom: 100 } })
  system.appendChild(staff)

  // measure 0: note [50,80], rest [100,130], chord [150,180]
  const noteEl = makeG('abcjs-note', { startChar: 10, rect: { left: 50, right: 80, top: 20, bottom: 80 } })
  const restEl = makeG('abcjs-rest', { startChar: 14, rect: { left: 100, right: 130, top: 20, bottom: 80 } })
  const chordEl = makeG('abcjs-note', { startChar: 18, rect: { left: 150, right: 180, top: 20, bottom: 80 } })
  // measure 1: note [250,280]
  const note2El = makeG('abcjs-note', { startChar: 30, rect: { left: 250, right: 280, top: 20, bottom: 80 } })
  const barEl = makeG('abcjs-bar')
  system.append(noteEl, restEl, chordEl, note2El, barEl)

  const map = buildMap([
    { startChar: 10, m: 0, e: 0 },
    { startChar: 14, m: 0, e: 1 },
    { startChar: 18, m: 0, e: 2, pitches: 3 },
    { startChar: 30, m: 1, e: 0 },
  ])

  const score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [note('C', 4), rest(), chord()] },
      { events: [note('D', 4)] },
    ],
  } as unknown as Score

  return { svg, system, staff, noteEl, restEl, chordEl, note2El, barEl, map, score }
}

describe('classifyContextTarget (M27)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('returns none when no staff resolves (pre-render / non-interactive)', () => {
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
    document.body.appendChild(svg)
    const map = buildMap([])
    const score = { key: 'C', meter: '4/4', measures: [{ events: [note('C', 4)] }] } as unknown as Score
    const target = classifyContextTarget(svg, { clientX: 10, clientY: 10, target: svg }, map, score, undefined)
    expect(target).toEqual({ kind: 'none' })
  })

  it('classifies a single notehead → note with the resolved selection + anchor', () => {
    const { svg, noteEl, map, score } = buildScene()
    const target = classifyContextTarget(svg, { clientX: 65, clientY: 50, target: noteEl }, map, score, undefined)
    expect(target.kind).toBe('note')
    if (target.kind !== 'note') throw new Error('expected note')
    expect(target.selection).toMatchObject({ staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, anchorX: 65, anchorY: 50 })
  })

  it('classifies a rest glyph → rest (rest-illegal verbs filtered downstream)', () => {
    const { svg, restEl, map, score } = buildScene()
    const target = classifyContextTarget(svg, { clientX: 115, clientY: 50, target: restEl }, map, score, undefined)
    expect(target.kind).toBe('rest')
    if (target.kind !== 'rest') throw new Error('expected rest')
    expect(target.selection).toMatchObject({ measureIdx: 0, eventIdx: 1 })
  })

  it('classifies a chord notehead → chordNote with a resolved pitchIdx', () => {
    const { svg, chordEl, map, score } = buildScene()
    const target = classifyContextTarget(svg, { clientX: 165, clientY: 50, target: chordEl }, map, score, undefined)
    expect(target.kind).toBe('chordNote')
    if (target.kind !== 'chordNote') throw new Error('expected chordNote')
    expect(target.selection.measureIdx).toBe(0)
    expect(target.selection.eventIdx).toBe(2)
    expect(typeof target.selection.pitchIdx).toBe('number')
  })

  it('classifies an empty-bar click → measure with the GLOBAL measureIdx from SourceMap', () => {
    const { svg, staff, map, score } = buildScene()
    // X=260 is inside measure 1's X-band [250,280]; target is the staff
    // (not a note/rest/bar), so the empty-area branch runs.
    const target = classifyContextTarget(svg, { clientX: 260, clientY: 50, target: staff }, map, score, undefined)
    expect(target.kind).toBe('measure')
    if (target.kind !== 'measure') throw new Error('expected measure')
    expect(target.measureIdx).toBe(1)
    expect(target.staffIdx).toBe(0)
  })

  it('classifies a barline click → barline', () => {
    const { svg, barEl, map, score } = buildScene()
    const target = classifyContextTarget(svg, { clientX: 70, clientY: 50, target: barEl }, map, score, undefined)
    expect(target.kind).toBe('barline')
    if (target.kind !== 'barline') throw new Error('expected barline')
    expect(target.staffIdx).toBe(0)
  })

  it('keeps an active range when the click lands inside it', () => {
    const { svg, staff, map, score } = buildScene()
    const range = { fromStart: 1, fromEnd: 1 }
    const target = classifyContextTarget(svg, { clientX: 260, clientY: 50, target: staff }, map, score, range)
    expect(target).toEqual({ kind: 'range', range })
  })

  it('collapses to a single measure when the click is outside the active range', () => {
    const { svg, staff, map, score } = buildScene()
    const range = { fromStart: 1, fromEnd: 1 }
    // X=110 → measure 0, which is outside [1,1].
    const target = classifyContextTarget(svg, { clientX: 110, clientY: 50, target: staff }, map, score, range)
    expect(target.kind).toBe('measure')
    if (target.kind !== 'measure') throw new Error('expected measure')
    expect(target.measureIdx).toBe(0)
  })

  it('classifies a click on a staff with no tagged events → empty', () => {
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
    document.body.appendChild(svg)
    const system = makeG('abcjs-staff-wrapper')
    svg.appendChild(system)
    const staff = makeG('abcjs-staff', { rect: { left: 0, right: 400, top: 0, bottom: 100 } })
    system.appendChild(staff)
    const map = buildMap([])
    const score = { key: 'C', meter: '4/4', measures: [{ events: [note('C', 4)] }] } as unknown as Score
    const target = classifyContextTarget(svg, { clientX: 200, clientY: 50, target: staff }, map, score, undefined)
    expect(target.kind).toBe('empty')
    if (target.kind !== 'empty') throw new Error('expected empty')
    expect(target.staffIdx).toBe(0)
  })

  it('never trusts DOM order: measureIdx always comes from the SourceMap', () => {
    const { svg, note2El, map, score } = buildScene()
    // Directly clicking measure 1's note resolves to measureIdx 1 even
    // though it is the 4th tagged node in document order.
    const target = classifyContextTarget(svg, { clientX: 265, clientY: 50, target: note2El }, map, score, undefined)
    expect(target.kind).toBe('note')
    if (target.kind !== 'note') throw new Error('expected note')
    expect(target.selection.measureIdx).toBe(1)
  })
})
