/* @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { snapTargetAtX } from '@/components/editor/snapTargetAtX'
import type { Score } from '@/lib/music/types'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'

/**
 * Regression for the vertical-drag pitch-change bug.
 *
 * `useNoteDrag` applies `transform="translate(dx,dy)"` to the source
 * notehead while the pointer is down. `snapTargetAtX` reads every
 * `[data-startchar]` element's `getBoundingClientRect()` to compute
 * candidate snap points — including the source's. With the live
 * transform in place, the source's "after-event" snap point inherits
 * the shifted centerY (it follows the drag), while its "leading-event"
 * snap point stays on the original row (because that point is emitted
 * from the PREVIOUS event's box, which has no transform). A pure-Y
 * drag therefore lands closer to the trailing point, which has
 * `position32nds != srcLeadingPos` → the drag is misread as a reorder
 * and `changePitch` never fires.
 *
 * Two layers defend against this:
 *   1. `useNoteDrag` strips the transform from the source notehead just
 *      for the snap measurement and reapplies it immediately after, so
 *      the source's two boundaries keep the same (original) Y. These
 *      tests model the corruption directly against `snapTargetAtX` so
 *      the strip-measure-restore contract is locked in: the same call
 *      returns the LEADING snap point when the transform is absent and
 *      the TRAILING snap point when it is present.
 *   2. The release-time classifier (`dragSnapIsReorder`) treats BOTH
 *      the leading AND trailing boundary of the dragged event as "still
 *      in its own slot" → pitch change. So even when the snap lands on
 *      the trailing edge (off-center grabs, or if the transform leaked
 *      through), the gesture still retunes instead of reordering. See
 *      dragSnapIsReorder.test.ts. The leading-vs-trailing distinction
 *      below therefore no longer flips pitch↔reorder on its own; these
 *      tests now only pin snapTargetAtX's raw geometry output.
 */

interface FakeEventBox {
  left: number
  right: number
  startChar: number
  /** centerY override (defaults to (top+bottom)/2 = 5). Used to
   *  simulate the transformed source notehead following the pointer. */
  centerY?: number
}

function fakeSvg(events: FakeEventBox[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const e of events) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-startchar', String(e.startChar))
    const cy = e.centerY ?? 5
    Object.defineProperty(g, 'getBoundingClientRect', {
      value: () =>
        ({
          left: e.left,
          right: e.right,
          top: cy - 5,
          bottom: cy + 5,
          width: e.right - e.left,
          height: 10,
          x: e.left,
          y: cy - 5,
          toJSON() {},
        }) as DOMRect,
    })
    svg.appendChild(g)
  }
  return svg as unknown as SVGSVGElement
}

function makeMap(
  entries: Array<{
    staffIdx: number
    voiceIdx: number
    measureIdx: number
    eventIdx: number
    startChar: number
  }>,
): SourceMap {
  return {
    events: entries.map((e) => ({ ...e, endChar: e.startChar + 10, pitchRanges: [] })),
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

const FOUR_QUARTERS: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

const MAP = makeMap([
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 100 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, startChar: 110 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 2, startChar: 120 },
  { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 3, startChar: 130 },
])

describe('snapTargetAtX vs a transformed source notehead (vertical-drag pitch-change bug)', () => {
  // Source is event 1 (the "D" quarter). srcLeadingPos = dur(event 0) =
  // 8 (32nds). The matching snap point is "after event 0", emitted at
  // clientX = bs[0].right = 140.
  const SOURCE_EVENT_IDX = 1
  const SRC_LEADING_POS = 8

  it('without a transform, a pure-Y drag picks the leading snap point of the source (pitch-change path)', () => {
    const svg = fakeSvg([
      { left: 100, right: 120, startChar: 100 }, // event 0
      { left: 120, right: 140, startChar: 110 }, // event 1 (source)
      { left: 140, right: 160, startChar: 120 }, // event 2
      { left: 160, right: 180, startChar: 130 }, // event 3
    ])
    // Pointer started on event 1's notehead (around X=130) and dragged
    // straight down by 30px → click Y is 30 below the staff row.
    const t = snapTargetAtX(svg, 130, MAP, FOUR_QUARTERS, 0, 35)
    expect(t).toBeDefined()
    expect(t?.position32nds).toBe(SRC_LEADING_POS)
  })

  it('with the source notehead transformed downward, the snap drifts to the trailing point (bug surface — what the fix avoids)', () => {
    // Same boxes, except the source event's centerY is shifted from 5
    // to 35 to model `setAttribute('transform','translate(0,30)')`.
    // snapTargetAtX has no way to know the shift is incidental; its 2D
    // distance math now lands the trailing point near the click.
    const svg = fakeSvg([
      { left: 100, right: 120, startChar: 100, centerY: 5 },
      { left: 120, right: 140, startChar: 110, centerY: 35 }, // shifted!
      { left: 140, right: 160, startChar: 120, centerY: 5 },
      { left: 160, right: 180, startChar: 130, centerY: 5 },
    ])
    const t = snapTargetAtX(svg, 130, MAP, FOUR_QUARTERS, 0, 35)
    expect(t).toBeDefined()
    // Note: this asserts the raw snap geometry — with the transform
    // leaked in, the snap is the trailing edge of the source (position
    // 16). useNoteDrag strips the transform before this call so the
    // snap stays on the leading edge; and even if it didn't, the
    // trailing edge is still classified as a pitch change by
    // dragSnapIsReorder, so the gesture retunes either way.
    expect(t?.position32nds).not.toBe(SRC_LEADING_POS)
    expect(t?.position32nds).toBe(SRC_LEADING_POS + 8) // 8 = quarter
  })

  // SOURCE_EVENT_IDX is referenced so the documenting comment doesn't
  // become a dead constant if someone repurposes the fixture.
  it('source event index sanity check', () => {
    expect(SOURCE_EVENT_IDX).toBe(1)
  })
})
