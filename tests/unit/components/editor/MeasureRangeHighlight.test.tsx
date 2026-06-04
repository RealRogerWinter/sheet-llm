import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { useRef } from 'react'
import { MeasureRangeHighlight } from '@/components/editor/MeasureRangeHighlight'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

/**
 * Render-tests for MeasureRangeHighlight (M19-PR-7). jsdom doesn't
 * compute real layout for SVG, so per-rect pixel geometry is
 * out-of-scope for unit tests (covered by Playwright in a future
 * milestone). What we CAN test:
 *   - The component returns null when no range / no editMap / no SVG.
 *   - When range is set, it queries `[data-startchar]` nodes and
 *     emits one overlay div per measure that has at least one event.
 *   - The set of overlay divs matches the range bounds.
 *   - Out-of-range measures' events don't generate overlay divs.
 *
 * We stub getBoundingClientRect on the test SVG nodes so the walk
 * produces predictable bounds without a layout engine.
 */

const THREE_BAR_SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
  ],
}

/**
 * Minimal SourceMap stub that resolves a startChar back to a
 * (staffIdx, voiceIdx, measureIdx, eventIdx). Each test event in
 * the SVG below gets a unique startChar (10, 20, 30) and the map
 * routes them to measureIdx 0, 1, 2 respectively.
 */
function makeNoteRange(measureIdx: number, sc: number) {
  return {
    staffIdx: 0,
    voiceIdx: 0,
    measureIdx,
    eventIdx: 0,
    pitchIdx: 0,
    startChar: sc,
    endChar: sc + 2,
  }
}

function makeTestMap(): SourceMap {
  const events = [
    {
      staffIdx: 0,
      voiceIdx: 0,
      measureIdx: 0,
      eventIdx: 0,
      startChar: 10,
      endChar: 12,
      pitchRanges: [makeNoteRange(0, 10)],
    },
    {
      staffIdx: 0,
      voiceIdx: 0,
      measureIdx: 1,
      eventIdx: 0,
      startChar: 20,
      endChar: 22,
      pitchRanges: [makeNoteRange(1, 20)],
    },
    {
      staffIdx: 0,
      voiceIdx: 0,
      measureIdx: 2,
      eventIdx: 0,
      startChar: 30,
      endChar: 32,
      pitchRanges: [makeNoteRange(2, 30)],
    },
  ]
  const byEvent = new Map(events.map((e) => [`${e.staffIdx}:${e.voiceIdx}:${e.measureIdx}:${e.eventIdx}`, e]))
  return { events, byEvent }
}

const TEST_MAP: SourceMap = makeTestMap()

function makeSvgWithEvents(): SVGSVGElement {
  const svgns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgns, 'svg') as SVGSVGElement
  const events = [10, 20, 30]
  for (const sc of events) {
    const g = document.createElementNS(svgns, 'g')
    g.setAttribute('data-startchar', String(sc))
    // Stub getBoundingClientRect so the walk doesn't bail on
    // width===0 && height===0. jsdom returns all-zero by default for
    // SVG elements.
    const rect = {
      left: sc,
      top: 100,
      right: sc + 8,
      bottom: 140,
      width: 8,
      height: 40,
      x: sc,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect
    Object.defineProperty(g, 'getBoundingClientRect', {
      value: () => rect,
      configurable: true,
    })
    svg.appendChild(g)
  }
  return svg
}

function seedStore(svg: SVGSVGElement) {
  useChatStore.setState({
    chatId: 'test',
    abc: 'X:1\nK:C\n',
    scoreJson: THREE_BAR_SCORE,
    editedScore: THREE_BAR_SCORE,
    editMap: TEST_MAP,
    selection: undefined,
    measureRangeSelection: undefined,
    history: [THREE_BAR_SCORE],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    pending: false,
    error: undefined,
  })
  // Attach the SVG to a host div the component will scoreRef into.
  const host = document.createElement('div')
  host.appendChild(svg)
  document.body.appendChild(host)
  return host
}

function Mount({ host }: { host: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement | null>(host)
  return <MeasureRangeHighlight scoreRef={ref} />
}

describe('MeasureRangeHighlight — render', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('returns null when no measureRangeSelection is set', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    render(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(0)
  })

  it('returns null when there is no editMap', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.setState({ editMap: undefined })
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 2 })
    })
    render(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(0)
  })

  it('returns null when the host contains no SVG yet', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    useChatStore.setState({
      scoreJson: THREE_BAR_SCORE,
      editedScore: THREE_BAR_SCORE,
      editMap: TEST_MAP,
      abc: 'X:1\n',
      measureRangeSelection: { fromStart: 0, fromEnd: 2 },
    })
    render(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(0)
  })

  it('renders one overlay rect per measure for a multi-bar range', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 2 })
    })
    render(<Mount host={host} />)
    const rects = screen.queryAllByTestId('measure-range-highlight')
    expect(rects).toHaveLength(3)
    // Sorted by measureIdx.
    expect(rects.map((r) => r.getAttribute('data-measure-idx'))).toEqual([
      '0',
      '1',
      '2',
    ])
  })

  it('renders only the measures within the range (out-of-range events skipped)', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    })
    render(<Mount host={host} />)
    const rects = screen.queryAllByTestId('measure-range-highlight')
    expect(rects).toHaveLength(1)
    expect(rects[0].getAttribute('data-measure-idx')).toBe('1')
  })

  it('clears overlay when the range is cleared', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 1 })
    })
    const { rerender } = render(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(2)
    act(() => {
      useChatStore.getState().selectMeasureRange(undefined)
    })
    rerender(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(0)
  })

  it('re-computes when the range changes', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    const { rerender } = render(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(1)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 2 })
    })
    rerender(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(3)
  })

  it('overlay divs are aria-hidden and pointer-events:none (no interaction interference)', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    })
    render(<Mount host={host} />)
    const rect = screen.getByTestId('measure-range-highlight')
    expect(rect.getAttribute('aria-hidden')).toBe('true')
    expect((rect as HTMLDivElement).style.pointerEvents).toBe('none')
  })

  it('overlay rect bounds are translated from the SourceMap-walked events with padding', () => {
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    })
    render(<Mount host={host} />)
    const rect = screen.getByTestId('measure-range-highlight') as HTMLDivElement
    // The mocked event at sc=20 produced rect { left:20, top:100, right:28, bottom:140 }.
    // With HPAD=6, VPAD=8: left=14, top=92, width=8+12=20, height=40+16=56.
    expect(rect.style.left).toBe('14px')
    expect(rect.style.top).toBe('92px')
    expect(rect.style.width).toBe('20px')
    expect(rect.style.height).toBe('56px')
  })

  it('computes overlays when the range is ALREADY set at mount time', () => {
    // Pins the M19-PR-7 review case: existing tests all act() the
    // range after render. This one seeds the range BEFORE mounting
    // so the FIRST useLayoutEffect run produces rects.
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 1 })
    render(<Mount host={host} />)
    const rects = screen.queryAllByTestId('measure-range-highlight')
    expect(rects).toHaveLength(2)
  })

  it('recomputes overlays when abc changes (score re-render)', () => {
    // abc is the re-render trigger for the geometry walk. When a
    // local edit produces a new abc, the overlay must re-walk and
    // emit new bounds — without this, the highlight would stick to
    // stale viewport coords from the previous render.
    const svg = makeSvgWithEvents()
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    })
    const { rerender } = render(<Mount host={host} />)
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(1)

    // Bump abc to simulate a local edit; effect should re-run.
    act(() => {
      useChatStore.setState({ abc: 'X:1\nK:G\nL:1/4\n' })
    })
    rerender(<Mount host={host} />)
    // Same range still produces 1 overlay (the new event bounds came
    // from the same svg + range — but the EFFECT fires fresh).
    expect(screen.queryAllByTestId('measure-range-highlight')).toHaveLength(1)
  })

  it('events with width=0 AND height=0 are skipped (defensive)', () => {
    // Mirrors the clickInsertSlot guard — abcjs sometimes emits empty
    // bounding-box decoration elements that we don't want to fold into
    // a measure's overlay bounds.
    const svgns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgns, 'svg') as SVGSVGElement
    // One real event + one width=0/height=0 ghost on the same measure.
    const real = document.createElementNS(svgns, 'g')
    real.setAttribute('data-startchar', '10')
    Object.defineProperty(real, 'getBoundingClientRect', {
      value: () => ({
        left: 10,
        top: 100,
        right: 18,
        bottom: 140,
        width: 8,
        height: 40,
        x: 10,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect),
      configurable: true,
    })
    const ghost = document.createElementNS(svgns, 'g')
    ghost.setAttribute('data-startchar', '10')
    Object.defineProperty(ghost, 'getBoundingClientRect', {
      value: () => ({
        left: 5000,
        top: 5000,
        right: 5000,
        bottom: 5000,
        width: 0,
        height: 0,
        x: 5000,
        y: 5000,
        toJSON: () => ({}),
      } as DOMRect),
      configurable: true,
    })
    svg.appendChild(real)
    svg.appendChild(ghost)
    const host = seedStore(svg)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    render(<Mount host={host} />)
    const rect = screen.getByTestId('measure-range-highlight') as HTMLDivElement
    // Ghost's 5000,5000 bounds did NOT inflate the rect — only the
    // real event contributed. With HPAD=6 left should still be 4 (10-6),
    // NOT 4994 (5000-6).
    expect(rect.style.left).toBe('4px')
  })
})
