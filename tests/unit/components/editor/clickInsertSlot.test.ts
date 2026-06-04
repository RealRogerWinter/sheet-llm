/* @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { clickInsertSlot } from '@/components/editor/clickInsertSlot'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'

// ── synthetic SVG helpers (mirrored from snapTargetAtX.test.ts) ─────────

interface FakeEventBox {
  left: number
  right: number
  startChar: number
}

function fakeSystem(events: FakeEventBox[]): { svg: SVGSVGElement; systemEl: SVGGElement } {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const systemEl = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  systemEl.setAttribute('class', 'abcjs-staff-wrapper')
  svg.appendChild(systemEl)
  for (const e of events) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-startchar', String(e.startChar))
    Object.defineProperty(g, 'getBoundingClientRect', {
      value: () =>
        ({
          left: e.left,
          right: e.right,
          top: 0,
          bottom: 10,
          width: e.right - e.left,
          height: 10,
          x: e.left,
          y: 0,
          toJSON() {},
        }) as DOMRect,
    })
    systemEl.appendChild(g)
  }
  return { svg: svg as unknown as SVGSVGElement, systemEl }
}

interface FakeMapEntry {
  staffIdx: number
  voiceIdx: number
  measureIdx: number
  eventIdx: number
  startChar: number
}

function makeMap(entries: FakeMapEntry[]): SourceMap {
  return {
    events: entries.map((e) => ({
      staffIdx: e.staffIdx,
      voiceIdx: e.voiceIdx,
      measureIdx: e.measureIdx,
      eventIdx: e.eventIdx,
      startChar: e.startChar,
      endChar: e.startChar + 10,
      pitchRanges: [],
    })),
    byEvent: new Map(),
  } as unknown as SourceMap
}

vi.mock('@/lib/music/scoreToAbcWithMap', async () => {
  const actual = await vi.importActual<typeof import('@/lib/music/scoreToAbcWithMap')>(
    '@/lib/music/scoreToAbcWithMap',
  )
  return {
    ...actual,
    resolveClickPosition: (m: SourceMap, sc: number) => {
      const eventsArr = (m as {
        events: Array<{
          staffIdx: number
          voiceIdx: number
          measureIdx: number
          eventIdx: number
          startChar: number
        }>
      }).events
      const found = eventsArr.find((e) => e.startChar === sc)
      return found
        ? {
            staffIdx: found.staffIdx,
            voiceIdx: found.voiceIdx,
            measureIdx: found.measureIdx,
            eventIdx: found.eventIdx,
          }
        : undefined
    },
  }
})

// ── fixtures ────────────────────────────────────────────────────────────

// Two measures of four quarter notes each, on staff 0.
//
//   measure 0: events 0..3, X-extent [100, 180]
//   measure 1: events 0..3, X-extent [200, 280]
const TWO_MEASURE_MAP = makeMap([
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 120 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 130 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 200 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 1, startChar: 210 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 2, startChar: 220 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 3, startChar: 230 },
])

const TWO_MEASURE_BOXES: FakeEventBox[] = [
  { left: 100, right: 120, startChar: 100 }, // m0 e0
  { left: 120, right: 140, startChar: 110 }, // m0 e1
  { left: 140, right: 160, startChar: 120 }, // m0 e2
  { left: 160, right: 180, startChar: 130 }, // m0 e3
  { left: 200, right: 220, startChar: 200 }, // m1 e0
  { left: 220, right: 240, startChar: 210 }, // m1 e1
  { left: 240, right: 260, startChar: 220 }, // m1 e2
  { left: 260, right: 280, startChar: 230 }, // m1 e3
]

// ── tests ──────────────────────────────────────────────────────────────

describe('clickInsertSlot — within-measure resolution', () => {
  it('clicks at the front of a measure → insertAfterIdx = -1', () => {
    const { svg, systemEl } = fakeSystem(TWO_MEASURE_BOXES)
    const slot = clickInsertSlot(svg, 90, TWO_MEASURE_MAP, 0, systemEl)
    expect(slot).toEqual({ measureIdx: 0, insertAfterIdx: -1 })
  })

  it('clicks between event 1 and event 2 → insertAfterIdx = 1', () => {
    const { svg, systemEl } = fakeSystem(TWO_MEASURE_BOXES)
    // 141 is just past event 1's right edge (140), before event 2.
    const slot = clickInsertSlot(svg, 141, TWO_MEASURE_MAP, 0, systemEl)
    expect(slot).toEqual({ measureIdx: 0, insertAfterIdx: 1 })
  })

  it('clicks past the last event of the measure → insertAfterIdx = last', () => {
    const { svg, systemEl } = fakeSystem(TWO_MEASURE_BOXES)
    // 190 is past event 3's right edge (180) but before measure 1.
    const slot = clickInsertSlot(svg, 190, TWO_MEASURE_MAP, 0, systemEl)
    expect(slot).toEqual({ measureIdx: 0, insertAfterIdx: 3 })
  })
})

describe('clickInsertSlot — multi-measure measureIdx selection', () => {
  it('clicks inside measure 1 land on measure 1 (not measure 0)', () => {
    const { svg, systemEl } = fakeSystem(TWO_MEASURE_BOXES)
    // 250 is in measure 1's X-band.
    const slot = clickInsertSlot(svg, 250, TWO_MEASURE_MAP, 0, systemEl)
    expect(slot?.measureIdx).toBe(1)
  })

  it('regression: click in measure 1 does not collapse to the last event of measure 0', () => {
    // The pre-fix code used `lastEventIdx = measure.events.length - 1`
    // unconditionally, so any click in any measure landed at the very
    // end of *that* measure. This test asserts the new code respects
    // both the chosen measure AND the click X within it.
    const { svg, systemEl } = fakeSystem(TWO_MEASURE_BOXES)
    // 225 sits past measure 1's event 0 (right edge 220) but inside
    // event 1's box — that's "insert after event 0", not "append".
    const slot = clickInsertSlot(svg, 225, TWO_MEASURE_MAP, 0, systemEl)
    expect(slot).toEqual({ measureIdx: 1, insertAfterIdx: 0 })
  })
})

describe('clickInsertSlot — staff filtering', () => {
  it('events on a different staff are ignored', () => {
    const STAFF1_MAP = makeMap([
      { staffIdx: 1, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
      { staffIdx: 1, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
    ])
    const boxes: FakeEventBox[] = [
      { left: 100, right: 120, startChar: 100 },
      { left: 120, right: 140, startChar: 110 },
    ]
    const { svg, systemEl } = fakeSystem(boxes)
    const slotOnStaff0 = clickInsertSlot(svg, 130, STAFF1_MAP, 0, systemEl)
    expect(slotOnStaff0).toBeUndefined()
    // X=145 sits just past event 1's right edge (140) → insertAfterIdx=1.
    const slotOnStaff1 = clickInsertSlot(svg, 145, STAFF1_MAP, 1, systemEl)
    expect(slotOnStaff1).toEqual({ measureIdx: 0, insertAfterIdx: 1 })
  })
})

describe('clickInsertSlot — cross-system measureIdx (regression for global-vs-system-local bug)', () => {
  it('returns the GLOBAL measure index from the SourceMap, not a system-local count', () => {
    // System 1 of a multi-system score: the events here belong to
    // measures 4 and 5 of the score, even though they're the first two
    // measures rendered in this system. The previous bar-counting
    // approach returned 0/1 here, which then routed the insert into the
    // wrong score measure. The SourceMap is the source of truth.
    const SYS1_MAP = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 4, eventIdx: 0, startChar: 400 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 4, eventIdx: 1, startChar: 410 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 5, eventIdx: 0, startChar: 500 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 5, eventIdx: 1, startChar: 510 },
    ])
    const boxes: FakeEventBox[] = [
      { left: 100, right: 120, startChar: 400 },
      { left: 120, right: 140, startChar: 410 },
      { left: 200, right: 220, startChar: 500 },
      { left: 220, right: 240, startChar: 510 },
    ]
    const { svg, systemEl } = fakeSystem(boxes)
    expect(clickInsertSlot(svg, 130, SYS1_MAP, 0, systemEl)?.measureIdx).toBe(4)
    expect(clickInsertSlot(svg, 230, SYS1_MAP, 0, systemEl)?.measureIdx).toBe(5)
  })
})

describe('clickInsertSlot — degenerate inputs', () => {
  it('returns undefined when the system has no tagged events on the target staff', () => {
    const { svg, systemEl } = fakeSystem([])
    const slot = clickInsertSlot(svg, 100, TWO_MEASURE_MAP, 0, systemEl)
    expect(slot).toBeUndefined()
  })

  it('zero-width events are skipped (they would otherwise sit at x=0,0)', () => {
    const { svg, systemEl } = fakeSystem([
      { left: 50, right: 50, startChar: 100 }, // zero-width — skipped
      { left: 100, right: 120, startChar: 110 },
    ])
    const slot = clickInsertSlot(svg, 110, TWO_MEASURE_MAP, 0, systemEl)
    // The zero-width entry would have falsely shifted the measure left
    // bound to 50 if not skipped. Confirm event 0 is gone from the
    // measure's view: clickX=110 sits inside event 1's box.
    expect(slot).toEqual({ measureIdx: 0, insertAfterIdx: -1 })
  })
})
