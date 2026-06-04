import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'
import { useMeasureRangeDrag } from '@/components/editor/useMeasureRangeDrag'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'

/**
 * Unit tests for useMeasureRangeDrag (M19-PR-8). Verifies the
 * drag-state lifecycle (threshold, pointermove, drop, cancel) and
 * dispatch wiring through to the dragMeasureRange op.
 *
 * Geometry resolution depends on clickInsertSlot + resolveStaffFromY
 * which walk the DOM via getBoundingClientRect — we stub those at
 * the DOM level so the resolved measureIdx is deterministic.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function cleanup() {
  document.body.innerHTML = ''
}

const THREE_BAR_SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
  ],
}

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
    { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, startChar: 10, endChar: 12, pitchRanges: [makeNoteRange(0, 10)] },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, startChar: 20, endChar: 22, pitchRanges: [makeNoteRange(1, 20)] },
    { staffIdx: 0, voiceIdx: 0, measureIdx: 2, eventIdx: 0, startChar: 30, endChar: 32, pitchRanges: [makeNoteRange(2, 30)] },
  ]
  const byEvent = new Map(events.map((e) => [`${e.staffIdx}:${e.voiceIdx}:${e.measureIdx}:${e.eventIdx}`, e]))
  return { events, byEvent }
}

/**
 * Each measure's event is positioned at a distinct viewport X:
 *   measure 0 → x 100, measure 1 → x 200, measure 2 → x 300.
 * This lets us drive resolveToAfter via clientX in pointermove/up.
 */
function makeSvgWithEvents(container: HTMLDivElement): SVGSVGElement {
  const svgns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgns, 'svg') as SVGSVGElement
  // staff-wrapper holds the staff group AND the per-event groups
  // (matches the abcjs DOM contract resolveStaffFromY + clickInsertSlot
  // expect: events are inside the systemEl == .abcjs-staff-wrapper).
  const wrapper = document.createElementNS(svgns, 'g')
  wrapper.setAttribute('class', 'abcjs-staff-wrapper')
  Object.defineProperty(wrapper, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 50, right: 1000, bottom: 200, width: 1000, height: 150, x: 0, y: 50, toJSON: () => ({}) } as DOMRect),
    configurable: true,
  })
  const staff = document.createElementNS(svgns, 'g')
  staff.setAttribute('class', 'abcjs-staff')
  Object.defineProperty(staff, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 80, right: 1000, bottom: 180, width: 1000, height: 100, x: 0, y: 80, toJSON: () => ({}) } as DOMRect),
    configurable: true,
  })
  wrapper.appendChild(staff)

  const positions = [100, 200, 300]
  for (const [i, x] of positions.entries()) {
    const g = document.createElementNS(svgns, 'g')
    g.setAttribute('data-startchar', String(10 + i * 10))
    Object.defineProperty(g, 'getBoundingClientRect', {
      value: () => ({ left: x, top: 100, right: x + 30, bottom: 140, width: 30, height: 40, x, y: 100, toJSON: () => ({}) } as DOMRect),
      configurable: true,
    })
    wrapper.appendChild(g)
  }
  svg.appendChild(wrapper)
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 50, right: 1000, bottom: 200, width: 1000, height: 150, x: 0, y: 50, toJSON: () => ({}) } as DOMRect),
    configurable: true,
  })
  container.appendChild(svg)
  return svg
}

function seed(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  makeSvgWithEvents(container)
  useChatStore.setState({
    chatId: 'test',
    abc: 'X:1\nK:C\n',
    scoreJson: THREE_BAR_SCORE,
    editedScore: THREE_BAR_SCORE,
    editMap: makeTestMap(),
    selection: undefined,
    measureRangeSelection: undefined,
    measureDragState: undefined,
    history: [THREE_BAR_SCORE],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    pending: false,
    error: undefined,
  })
  return container
}

function mountHook(container: HTMLDivElement) {
  renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(container)
    useMeasureRangeDrag(ref)
  })
}

function pointerDown(target: EventTarget, clientX: number, clientY: number, init: Partial<PointerEvent> = {}) {
  const e = new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX, clientY, ...init })
  target.dispatchEvent(e)
}
function pointerMove(clientX: number, clientY: number) {
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY }))
}
function pointerUp(clientX: number, clientY: number) {
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX, clientY }))
}

describe('useMeasureRangeDrag — lifecycle (M19-PR-8)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('does not start a drag without a range selection', () => {
    const container = seed()
    mountHook(container)
    pointerDown(container, 100, 110)
    pointerMove(150, 110)
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('does not start a drag when pointer is outside the range', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    // Pointer over measure 2 (x=300) is OUTSIDE range [0..0].
    pointerDown(container, 300, 110)
    pointerMove(350, 110)
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('does not start a drag when modifier keys are held (Cmd/Ctrl/Shift/Alt)', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 1 })
    })
    pointerDown(container, 100, 110, { ctrlKey: true })
    pointerMove(150, 110)
    expect(useChatStore.getState().measureDragState).toBeUndefined()
    pointerDown(container, 100, 110, { shiftKey: true })
    pointerMove(150, 110)
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('bails when pointerdown target is a notehead (useNoteDrag owns it) — MUST FIX #5', () => {
    // Code-review MUST FIX: dragging a notehead INSIDE a highlighted
    // range would otherwise arm BOTH useNoteDrag AND
    // useMeasureRangeDrag, producing a double-dispatch (reorder +
    // dragMeasureRange-move) on the same pointerup. The fix bails
    // in useMeasureRangeDrag.onPointerDown when target.closest(
    // '.abcjs-note') is non-null. Same for '.abcjs-rest'.
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 2 })
    })
    // Create a fake notehead element INSIDE the range bar; the
    // pointerdown target.closest('.abcjs-note') gate should bail.
    const svgns = 'http://www.w3.org/2000/svg'
    const note = document.createElementNS(svgns, 'g')
    note.setAttribute('class', 'abcjs-note')
    Object.defineProperty(note, 'getBoundingClientRect', {
      value: () => ({ left: 100, top: 100, right: 130, bottom: 140, width: 30, height: 40, x: 100, y: 100, toJSON: () => ({}) } as DOMRect),
      configurable: true,
    })
    container.querySelector('svg')!.appendChild(note)
    pointerDown(note, 110, 110)
    pointerMove(200, 110) // 90px move — well past threshold
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('does not start a drag below the 4px threshold (click, not drag)', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    pointerDown(container, 100, 110)
    pointerMove(102, 111) // <4px movement
    expect(useChatStore.getState().measureDragState).toBeUndefined()
    pointerUp(102, 111)
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('starts a drag once threshold is crossed; updates toAfter on pointermove', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    pointerDown(container, 100, 110)
    pointerMove(300, 110) // cursor over measure 2 — outside range
    const state = useChatStore.getState().measureDragState
    expect(state).toBeDefined()
    expect(state?.sourceRange).toEqual({ fromStart: 0, fromEnd: 0 })
    expect(state?.clientX).toBe(300)
    // Dropping AFTER measure 2 → toAfter = 2 (source idx 0 < 2).
    expect(state?.toAfter).toBe(2)
  })

  it('toAfter is null when the cursor is over the source range (no-op drop)', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    })
    // Pointer down OVER the range (x=200 = measure 1).
    pointerDown(container, 200, 110)
    pointerMove(210, 110) // crosses threshold, still over measure 1
    expect(useChatStore.getState().measureDragState?.toAfter).toBeNull()
  })

  it('pointerup dispatches dragMeasureRange-move and updates the range to the destination', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    pointerDown(container, 100, 110)
    pointerMove(300, 110)
    act(() => {
      pointerUp(300, 110)
    })
    // Move bar 0 to after bar 2. Result: [D, E, C].
    const score = useChatStore.getState().editedScore!
    expect(score.measures.map((m) => m.events[0].pitches[0].step)).toEqual(['D', 'E', 'C'])
    // Range updated to follow the moved content: bar 0 is now at idx 2.
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 2, fromEnd: 2 })
    // Drag state cleared.
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('pointerup on the source range is a no-op (no dispatch, drag state clears)', () => {
    const container = seed()
    mountHook(container)
    const original = useChatStore.getState().editedScore
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 1 })
    })
    pointerDown(container, 200, 110)
    pointerMove(210, 110) // threshold crossed
    act(() => {
      pointerUp(210, 110) // still over the source
    })
    // Score unchanged.
    expect(useChatStore.getState().editedScore).toBe(original)
    expect(useChatStore.getState().measureDragState).toBeUndefined()
  })

  it('Esc cancels an in-flight drag without dispatching', () => {
    const container = seed()
    mountHook(container)
    const original = useChatStore.getState().editedScore
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 0 })
    })
    pointerDown(container, 100, 110)
    pointerMove(300, 110)
    expect(useChatStore.getState().measureDragState).toBeDefined()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useChatStore.getState().measureDragState).toBeUndefined()
    // Score unchanged.
    expect(useChatStore.getState().editedScore).toBe(original)
    // Range selection preserved.
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 0, fromEnd: 0 })
  })

  it('drop AFTER the source moves the range; range follows the moved content', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 1 })
    })
    // Drag from inside range (x=100 over bar 0) to bar 2 (x=300).
    pointerDown(container, 100, 110)
    pointerMove(300, 110)
    act(() => {
      pointerUp(300, 110)
    })
    // Move bars 0-1 to after bar 2. Stripped: [E]. Insert after idx 0
    // (remappedToAfter=2-2=0) → [E, C, D]. Range follows to bars 1..2.
    const score = useChatStore.getState().editedScore!
    expect(score.measures.map((m) => m.events[0].pitches[0].step)).toEqual(['E', 'C', 'D'])
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 1, fromEnd: 2 })
  })

  it('drop BEFORE the source moves the range backward; range follows', () => {
    const container = seed()
    mountHook(container)
    act(() => {
      useChatStore.getState().selectMeasureRange({ fromStart: 2, fromEnd: 2 })
    })
    pointerDown(container, 300, 110)
    pointerMove(100, 110) // cursor over bar 0
    act(() => {
      pointerUp(100, 110)
    })
    // Move bar 2 to before bar 0 (toAfter = 0 - 1 = -1).
    // Result: [E, C, D]. Range follows to bar 0.
    const score = useChatStore.getState().editedScore!
    expect(score.measures.map((m) => m.events[0].pitches[0].step)).toEqual(['E', 'C', 'D'])
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 0, fromEnd: 0 })
  })
})
