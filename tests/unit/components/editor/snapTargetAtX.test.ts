/* @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { snapTargetAtX } from '@/components/editor/snapTargetAtX'
import type { Score } from '@/lib/music/types'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'

// ── synthetic SVG helpers ──────────────────────────────────────────────

interface FakeEventBox {
  left: number
  right: number
  startChar: number
}

function fakeSvg(events: FakeEventBox[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
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
    svg.appendChild(g)
  }
  return svg as unknown as SVGSVGElement
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
      const eventsArr = (m as { events: Array<{ staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number; startChar: number }> }).events
      const found = eventsArr.find((e) => e.startChar === sc)
      return found
        ? { staffIdx: found.staffIdx, voiceIdx: found.voiceIdx, measureIdx: found.measureIdx, eventIdx: found.eventIdx }
        : undefined
    },
  }
})

// ── fixtures ───────────────────────────────────────────────────────────

const FOUR_QUARTERS: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

const FOUR_QUARTERS_MAP = makeMap([
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 120 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 130 },
])

const FOUR_QUARTERS_BOXES: FakeEventBox[] = [
  { left: 100, right: 120, startChar: 100 },
  { left: 120, right: 140, startChar: 110 },
  { left: 140, right: 160, startChar: 120 },
  { left: 160, right: 180, startChar: 130 },
]

// ── baseline: existing behavior preserved ─────────────────────────────

describe('snapTargetAtX — single voice, all notes', () => {
  it('snaps to the front of the measure when pointer is past the left edge', () => {
    const svg = fakeSvg(FOUR_QUARTERS_BOXES)
    const t = snapTargetAtX(svg, 100, FOUR_QUARTERS_MAP, FOUR_QUARTERS)
    expect(t?.position32nds).toBe(0)
    expect(t?.clientX).toBe(100)
  })

  it('snaps to the right edge of an event when pointer is over it', () => {
    const svg = fakeSvg(FOUR_QUARTERS_BOXES)
    const t = snapTargetAtX(svg, 118, FOUR_QUARTERS_MAP, FOUR_QUARTERS)
    expect(t?.position32nds).toBe(8)
    expect(t?.clientX).toBe(120)
  })

  it('snaps to the end of the measure when pointer is past the last event', () => {
    const svg = fakeSvg(FOUR_QUARTERS_BOXES)
    const t = snapTargetAtX(svg, 200, FOUR_QUARTERS_MAP, FOUR_QUARTERS)
    expect(t?.position32nds).toBe(32)
    expect(t?.clientX).toBe(180)
  })

  it('returns undefined when no [data-startchar] elements exist', () => {
    const svg = fakeSvg([])
    const t = snapTargetAtX(svg, 100, FOUR_QUARTERS_MAP, FOUR_QUARTERS)
    expect(t).toBeUndefined()
  })

  it('staffFilter excludes points on other staves', () => {
    const svg = fakeSvg(FOUR_QUARTERS_BOXES)
    const t = snapTargetAtX(svg, 100, FOUR_QUARTERS_MAP, FOUR_QUARTERS, 1)
    expect(t).toBeUndefined()
  })
})

// ── BUG REPRO: measures with rests ────────────────────────────────────
//
// This is the precise reported failure. With rests untagged, the
// cumulative-32nds counter skipped rest durations, producing wrong
// snap positions. The fix tags rests too (ScorePanel.tagNoteheads...).
// These tests run AGAINST the fixed algorithm — they assert the
// correct positions a rest-aware cumulative produces.

describe('snapTargetAtX — measures with rests (bug repro)', () => {
  // m0: [eighth-rest(4), quarter(8), quarter(8), quarter(8), eighth-rest(4)]
  // Boundaries: 0, 4, 12, 20, 28, 32
  const SCORE_LEAD_AND_TRAIL_REST: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'eighth' },
      ] },
    ],
  }

  const MAP_LEAD_TRAIL = makeMap([
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 }, // rest
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 }, // C
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 120 }, // D
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 130 }, // E
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 4, startChar: 140 }, // rest
  ])

  // All 5 events (notes + rests), tagged contiguously.
  const BOXES_LEAD_TRAIL: FakeEventBox[] = [
    { left: 100, right: 120, startChar: 100 }, // rest 0
    { left: 120, right: 140, startChar: 110 }, // C
    { left: 140, right: 160, startChar: 120 }, // D
    { left: 160, right: 180, startChar: 130 }, // E
    { left: 180, right: 200, startChar: 140 }, // rest 4
  ]

  it('click at front of measure (left of leading rest) → position 0', () => {
    const svg = fakeSvg(BOXES_LEAD_TRAIL)
    const t = snapTargetAtX(svg, 100, MAP_LEAD_TRAIL, SCORE_LEAD_AND_TRAIL_REST)
    expect(t?.position32nds).toBe(0)
    expect(t?.clientX).toBe(100)
  })

  it('click at right of leading rest = left of C → position 4 (was 0 pre-fix)', () => {
    const svg = fakeSvg(BOXES_LEAD_TRAIL)
    const t = snapTargetAtX(svg, 120, MAP_LEAD_TRAIL, SCORE_LEAD_AND_TRAIL_REST)
    expect(t?.position32nds).toBe(4)
    expect(t?.clientX).toBe(120)
  })

  it('click at right of C → position 12 (was 8 pre-fix)', () => {
    const svg = fakeSvg(BOXES_LEAD_TRAIL)
    const t = snapTargetAtX(svg, 140, MAP_LEAD_TRAIL, SCORE_LEAD_AND_TRAIL_REST)
    expect(t?.position32nds).toBe(12)
    expect(t?.clientX).toBe(140)
  })

  it('click at right of E → position 28 (was 24 pre-fix)', () => {
    const svg = fakeSvg(BOXES_LEAD_TRAIL)
    const t = snapTargetAtX(svg, 180, MAP_LEAD_TRAIL, SCORE_LEAD_AND_TRAIL_REST)
    expect(t?.position32nds).toBe(28)
    expect(t?.clientX).toBe(180)
  })

  it('click at end of trailing rest → position 32 (end of measure)', () => {
    const svg = fakeSvg(BOXES_LEAD_TRAIL)
    const t = snapTargetAtX(svg, 200, MAP_LEAD_TRAIL, SCORE_LEAD_AND_TRAIL_REST)
    expect(t?.position32nds).toBe(32)
    expect(t?.clientX).toBe(200)
  })

  // Interior rest: [quarter(8), quarter-rest(8), quarter(8), quarter-rest(8)]
  // Boundaries: 0, 8, 16, 24, 32
  it('measure with interior rest: cumulative offsets include the rest', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
        ] },
      ],
    }
    const map = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 200 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 210 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 220 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 230 },
    ])
    const boxes: FakeEventBox[] = [
      { left: 100, right: 120, startChar: 200 },
      { left: 120, right: 140, startChar: 210 },
      { left: 140, right: 160, startChar: 220 },
      { left: 160, right: 180, startChar: 230 },
    ]
    const svg = fakeSvg(boxes)
    expect(snapTargetAtX(svg, 120, map, score)?.position32nds).toBe(8)
    expect(snapTargetAtX(svg, 140, map, score)?.position32nds).toBe(16)
    expect(snapTargetAtX(svg, 160, map, score)?.position32nds).toBe(24)
    expect(snapTargetAtX(svg, 180, map, score)?.position32nds).toBe(32)
  })

  // Whole-measure rest in 4/4: single event of duration whole.
  it('measure with single whole-rest: snap points are 0 and 32', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const map = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 300 },
    ])
    const boxes: FakeEventBox[] = [{ left: 100, right: 200, startChar: 300 }]
    const svg = fakeSvg(boxes)
    expect(snapTargetAtX(svg, 100, map, score)?.position32nds).toBe(0)
    expect(snapTargetAtX(svg, 200, map, score)?.position32nds).toBe(32)
  })
})

// ── whole-measure-rest geometry: extend right boundary to next measure

describe('snapTargetAtX — whole-measure rest geometry', () => {
  // 4/4: m0 has a single whole-rest (centered glyph); m1 has a whole
  // note. abcjs centers the whole-rest, so bs[0].right of the rest is
  // somewhere in the middle of the visual measure. The fix uses m1's
  // first-event left as the right snap clientX for m0's "after rest"
  // point, approximating the barline position between the two.
  const score: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    ],
  }
  const map = makeMap([
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 110 },
  ])
  // m0 whole-rest glyph centered at clientX 200 (left 180..right 220);
  // visually the measure spans 100..280. m1's first event starts at
  // left 280. The "after rest" snap clientX should be 280 (next measure
  // left), NOT 220 (centered glyph right).
  const boxes: FakeEventBox[] = [
    { left: 180, right: 220, startChar: 100 }, // m0 whole-rest (centered)
    { left: 280, right: 360, startChar: 110 }, // m1 whole note
  ]

  it('extends "after whole-rest" snap clientX to next measure left edge', () => {
    const svg = fakeSvg(boxes)
    // Click at 270: closer to next-measure-left (280, diff 10) than to
    // m1.right (360, diff 90). Should report m0 end (pos 32) at the
    // extended boundary clientX 280, NOT m1 front (also at 280 but
    // pos 0 in m1). Tie-break is first-wins on equal distance: m0's
    // after-rest comes first in iteration order.
    const t = snapTargetAtX(svg, 270, map, score)
    expect(t?.measureIdx).toBe(0)
    expect(t?.position32nds).toBe(32)
    expect(t?.clientX).toBe(280)
  })

  it('falls back to glyph.right when there is NO next measure (last bar)', () => {
    const lastBarScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const lastBarMap = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
    ])
    const lastBarBoxes: FakeEventBox[] = [{ left: 180, right: 220, startChar: 100 }]
    const svg = fakeSvg(lastBarBoxes)
    // No next measure → bs[0].right is used as the end-of-measure clientX.
    const t = snapTargetAtX(svg, 220, lastBarMap, lastBarScore)
    expect(t?.position32nds).toBe(32)
    expect(t?.clientX).toBe(220)
  })

  it('does NOT extend right boundary when measure has multiple rests (non-centered)', () => {
    // Two half-rests in 4/4. abcjs renders these as normal glyphs at
    // proper positions, so the override should NOT fire.
    const score2: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [
          { pitches: [{ step: 'rest', octave: 4 }], duration: 'half' },
          { pitches: [{ step: 'rest', octave: 4 }], duration: 'half' },
        ] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const map2 = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 120 },
    ])
    const boxes2: FakeEventBox[] = [
      { left: 100, right: 150, startChar: 100 },
      { left: 150, right: 200, startChar: 110 },
      { left: 280, right: 360, startChar: 120 },
    ]
    const svg = fakeSvg(boxes2)
    // The "after second half-rest" snap should be at clientX 200 (not
    // extended to 280 — multi-event rest measure is not centered).
    const t = snapTargetAtX(svg, 200, map2, score2)
    expect(t?.measureIdx).toBe(0)
    expect(t?.position32nds).toBe(32)
    expect(t?.clientX).toBe(200)
  })

  it('whole-rest in 3/4 (dotted-half rest) also triggers the extension', () => {
    // Dotted-half (24) === 3/4 capacity. Single-event rest measure.
    const score3: Score = {
      key: 'C',
      meter: '3/4',
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'dotted-half' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'dotted-half' }] },
      ],
    }
    const map3 = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 110 },
    ])
    const boxes3: FakeEventBox[] = [
      { left: 180, right: 220, startChar: 100 }, // centered glyph
      { left: 280, right: 360, startChar: 110 },
    ]
    const svg = fakeSvg(boxes3)
    const t = snapTargetAtX(svg, 270, map3, score3)
    expect(t?.measureIdx).toBe(0)
    expect(t?.position32nds).toBe(24) // capacity for 3/4
    expect(t?.clientX).toBe(280)
  })
})

// ── multi-measure: snap groups per measure ─────────────────────────────

describe('snapTargetAtX — multi-measure', () => {
  it('snap returns the correct measureIdx for a click near the end of m1', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const map = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 110 },
    ])
    const boxes: FakeEventBox[] = [
      { left: 100, right: 200, startChar: 100 },
      { left: 250, right: 350, startChar: 110 },
    ]
    const svg = fakeSvg(boxes)
    // clientX 340: closest is m1.right=350 (diff 10) → m1 end, pos 32.
    const t = snapTargetAtX(svg, 340, map, score)
    expect(t?.measureIdx).toBe(1)
    expect(t?.position32nds).toBe(32)
  })

  it('snap returns measureIdx 1 with pos 0 for clicks near the start of m1', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const map = makeMap([
      { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
      { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 110 },
    ])
    const boxes: FakeEventBox[] = [
      { left: 100, right: 200, startChar: 100 },
      { left: 250, right: 350, startChar: 110 },
    ]
    const svg = fakeSvg(boxes)
    // clientX 260: closest is m1.left=250 (diff 10) → m1 front, pos 0.
    const t = snapTargetAtX(svg, 260, map, score)
    expect(t?.measureIdx).toBe(1)
    expect(t?.position32nds).toBe(0)
  })
})

// ── multi-voice: per-voice cumulative reset ────────────────────────────

describe('snapTargetAtX — multi-voice (regression: voice in group key)', () => {
  // Two voices on one staff:
  //   v0: [quarter(8), quarter(8), quarter(8), quarter(8)]
  //   v1: [half(16), half(16)]
  // BEFORE FIX: grouping by (staffIdx, measureIdx) would mix the two voices
  // and produce a wildly wrong cumulative. After fix: each voice tracked
  // independently.
  const score: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ] },
    ],
    extraVoices: [
      { measures: [{ events: [
        { pitches: [{ step: 'A', octave: 5 }], duration: 'half' },
        { pitches: [{ step: 'B', octave: 5 }], duration: 'half' },
      ] }] },
    ],
  }
  const map = makeMap([
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 120 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 130 },
    { staffIdx: 0, voiceIdx: 1, measureIdx: 0, eventIdx: 0, startChar: 200 },
    { staffIdx: 0, voiceIdx: 1, measureIdx: 0, eventIdx: 1, startChar: 210 },
  ])
  const boxes: FakeEventBox[] = [
    { left: 100, right: 120, startChar: 100 }, // v0/e0
    { left: 120, right: 140, startChar: 110 }, // v0/e1
    { left: 140, right: 160, startChar: 120 }, // v0/e2
    { left: 160, right: 180, startChar: 130 }, // v0/e3
    { left: 100, right: 140, startChar: 200 }, // v1/e0 (half)
    { left: 140, right: 180, startChar: 210 }, // v1/e1 (half)
  ]

  it('voice cumulative does not include other voice durations', () => {
    const svg = fakeSvg(boxes)
    // Click at clientX 180 — closest right edge in v0 is 180 (pos 32),
    // also matches v1 right (180 → pos 32). Both report 32. Without
    // voice grouping the cumulative would over-count and produce
    // values > 32.
    const t = snapTargetAtX(svg, 180, map, score)
    expect(t?.position32nds).toBe(32)
  })

  it('voice 0 boundary after first quarter is position 8 (not 16 from interleaving)', () => {
    const svg = fakeSvg(boxes)
    const t = snapTargetAtX(svg, 120, map, score)
    expect(t?.position32nds).toBe(8)
  })

  it('voice 1 boundary after first half is position 16', () => {
    const svg = fakeSvg(boxes)
    // clientX 140 is the right edge of v1/e0 AND of v0/e1. Both pos
    // would be valid snap points; whichever wins, position is 16
    // (v0: 8+8=16; v1: 16). Important: NOT 24 or 32 which would
    // indicate buggy interleaving across voices.
    const t = snapTargetAtX(svg, 140, map, score)
    expect(t?.position32nds).toBe(16)
  })
})

// ── multi-staff: staffFilter restricts candidates ──────────────────────

describe('snapTargetAtX — multi-staff (grand staff)', () => {
  const score: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    ],
    secondStaff: {
      clef: 'bass',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
      ],
    },
  }
  const map = makeMap([
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
    { staffIdx: 1, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 200 },
  ])
  const boxes: FakeEventBox[] = [
    { left: 100, right: 200, startChar: 100 }, // primary
    { left: 100, right: 200, startChar: 200 }, // second staff (overlapping X)
  ]

  it('staffFilter=0 only returns staff 0 snap points', () => {
    const svg = fakeSvg(boxes)
    const t = snapTargetAtX(svg, 150, map, score, 0)
    expect(t?.staffIdx).toBe(0)
  })

  it('staffFilter=1 only returns staff 1 snap points', () => {
    const svg = fakeSvg(boxes)
    const t = snapTargetAtX(svg, 150, map, score, 1)
    expect(t?.staffIdx).toBe(1)
  })

  it('no staffFilter: returns ANY staff (first match wins on ties)', () => {
    const svg = fakeSvg(boxes)
    const t = snapTargetAtX(svg, 150, map, score)
    expect(t).toBeDefined()
    expect([0, 1]).toContain(t!.staffIdx)
    expect(t?.position32nds).toBe(0)
  })
})

// ── tuplet snap: current behavior is face-value (known limitation) ────
//
// DURATION_32NDS is face-value: a quarter-triplet member contributes
// 8 cumulative 32nds even though musically it occupies 8 × 2/3 ≈ 5.33.
// abcjs renders tuplet members at the scaled visual width, so the
// cumulative drifts from the visual right-edge for any snap point
// beyond the tuplet group. PRACTICAL IMPACT: `insertionWouldSplitTuplet`
// in transformScoreBalanced.reorderBalanced rejects mid-tuplet drops,
// so the drift only affects "after this tuplet" snap clientX — the
// chosen boundary is still a valid event boundary (eventIdx is right),
// just the visual feedback line may not exactly line up with the user's
// pointer.
//
// FIX requires a finer time unit divisible by lcm(3, 5, 6, 7) = 420
// for integer-exact tuplet arithmetic, or accepting fractional units.
// Out of scope for this PR.

describe('snapTargetAtX — tuplet face-value behavior (documented limitation)', () => {
  // Measure: half + 3-tuplet of eighth + quarter in 4/4.
  // Validate-side units: half=4 eighths + (3 × 1 × 2/3)=2 eighths + quarter=2 eighths = 8 eighths ✓
  // Face-value 32nds sum: 16 + (4 × 3) + 8 = 36. The snap cumulative will
  // climb to 36 (NOT 32 = real-time capacity).
  const score: Score = {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      ] },
    ],
  }
  const map = makeMap([
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 120 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 130 },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 4, startChar: 140 },
  ])
  const boxes: FakeEventBox[] = [
    { left: 100, right: 140, startChar: 100 }, // half
    { left: 140, right: 155, startChar: 110 }, // triplet eighth (visually narrower)
    { left: 155, right: 170, startChar: 120 },
    { left: 170, right: 185, startChar: 130 },
    { left: 185, right: 215, startChar: 140 }, // quarter
  ]

  it('cumulative after tuplet uses face-value duration (climbs past capacity)', () => {
    const svg = fakeSvg(boxes)
    // Click at 185 = right-of-last-triplet = left-of-quarter.
    // Face-value cumulative: 16 (half) + 4+4+4 (tuplet) = 28.
    const t = snapTargetAtX(svg, 185, map, score)
    expect(t?.position32nds).toBe(28)
  })

  it('cumulative after the entire measure exceeds meter capacity (face-value sum)', () => {
    const svg = fakeSvg(boxes)
    // Click at 215 = right of quarter (end of measure).
    // Face-value cumulative: 16 + 12 + 8 = 36. NOT 32 (the real-time
    // capacity per validateScore's tuplet-aware sum). This drift is
    // documented and accepted: insertionWouldSplitTuplet rejects mid-
    // tuplet drops and reorderBalanced's bounds-check on dstPosition
    // is also face-value, so the system remains internally consistent.
    const t = snapTargetAtX(svg, 215, map, score)
    expect(t?.position32nds).toBe(36)
  })
})

// ── degenerate inputs ──────────────────────────────────────────────────

describe('snapTargetAtX — degenerate inputs', () => {
  it('ignores tagged elements whose SourceMap entry is missing', () => {
    const map = makeMap([])
    const svg = fakeSvg(FOUR_QUARTERS_BOXES)
    expect(snapTargetAtX(svg, 100, map, FOUR_QUARTERS)).toBeUndefined()
  })

  it('ignores tagged elements with invalid data-startchar attribute', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-startchar', 'not-a-number')
    Object.defineProperty(g, 'getBoundingClientRect', {
      value: () =>
        ({ left: 100, right: 120, top: 0, bottom: 10, width: 20, height: 10, x: 100, y: 0, toJSON() {} }) as DOMRect,
    })
    svg.appendChild(g)
    expect(
      snapTargetAtX(svg as unknown as SVGSVGElement, 100, FOUR_QUARTERS_MAP, FOUR_QUARTERS),
    ).toBeUndefined()
  })

  it('skips zero-width rect elements (jsdom default)', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-startchar', '100')
    svg.appendChild(g)
    expect(
      snapTargetAtX(svg as unknown as SVGSVGElement, 100, FOUR_QUARTERS_MAP, FOUR_QUARTERS),
    ).toBeUndefined()
  })
})
