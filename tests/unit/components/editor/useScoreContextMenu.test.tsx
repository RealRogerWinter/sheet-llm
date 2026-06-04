import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useRef } from 'react'
import { render } from '@testing-library/react'
import { useScoreContextMenu } from '@/components/editor/useScoreContextMenu'
import { useChatStore } from '@/lib/chat/state'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

const NS = 'http://www.w3.org/2000/svg'

function stubRect(el: Element, r: { left: number; right: number; top: number; bottom: number }) {
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

function buildSceneInto(container: HTMLElement) {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  const system = document.createElementNS(NS, 'g')
  system.setAttribute('class', 'abcjs-staff-wrapper')
  svg.appendChild(system)
  const staff = document.createElementNS(NS, 'g')
  staff.setAttribute('class', 'abcjs-staff')
  stubRect(staff, { left: 0, right: 400, top: 0, bottom: 100 })
  system.appendChild(staff)
  const noteEl = document.createElementNS(NS, 'g')
  noteEl.setAttribute('class', 'abcjs-note')
  noteEl.setAttribute('data-startchar', '10')
  stubRect(noteEl, { left: 50, right: 80, top: 20, bottom: 80 })
  system.appendChild(noteEl)
  container.appendChild(svg)
  return { svg, noteEl }
}

const map: SourceMap = {
  events: [
    {
      staffIdx: 0,
      voiceIdx: 0,
      measureIdx: 0,
      eventIdx: 0,
      startChar: 10,
      endChar: 12,
      pitchRanges: [
        { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, pitchIdx: 0, startChar: 10, endChar: 11 },
      ],
    },
  ],
  byEvent: new Map(),
}

const score = {
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' }] }],
} as unknown as Score

function Harness({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useScoreContextMenu(ref, enabled)
  return <div ref={ref} data-testid="container" />
}

function fireContextMenu(el: Element, opts: { ctrlKey?: boolean } = {}) {
  const ev = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 65,
    clientY: 50,
    ctrlKey: opts.ctrlKey ?? false,
  })
  el.dispatchEvent(ev)
  return ev
}

describe('useScoreContextMenu (M27-PR-2)', () => {
  const origFlag = process.env.NEXT_PUBLIC_SL_CONTEXT_MENU

  beforeEach(() => {
    useChatStore.setState({
      editedScore: score,
      editMap: map,
      selection: undefined,
      measureRangeSelection: undefined,
    })
    useChatStore.getState().closeContextMenu()
  })

  afterEach(() => {
    if (origFlag === undefined) delete process.env.NEXT_PUBLIC_SL_CONTEXT_MENU
    else process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = origFlag
    useChatStore.setState({ editedScore: undefined, editMap: undefined, selection: undefined })
    useChatStore.getState().closeContextMenu()
  })

  it('right-click on a note (flag on) preventDefaults, selects, and opens the menu', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    const { getByTestId } = render(<Harness enabled />)
    const { noteEl } = buildSceneInto(getByTestId('container'))
    const ev = fireContextMenu(noteEl)
    expect(ev.defaultPrevented).toBe(true)
    expect(useChatStore.getState().contextMenu?.target.kind).toBe('note')
    expect(useChatStore.getState().selection?.measureIdx).toBe(0)
  })

  it('with the flag off, the native menu is left alone', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'off'
    const { getByTestId } = render(<Harness enabled />)
    const { noteEl } = buildSceneInto(getByTestId('container'))
    const ev = fireContextMenu(noteEl)
    expect(ev.defaultPrevented).toBe(false)
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('with enabled=false (outgoing crossfade layer) no listener fires', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    const { getByTestId } = render(<Harness enabled={false} />)
    const { noteEl } = buildSceneInto(getByTestId('container'))
    const ev = fireContextMenu(noteEl)
    expect(ev.defaultPrevented).toBe(false)
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('Ctrl+click is left to measure-range-select (native menu, no context menu)', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    const { getByTestId } = render(<Harness enabled />)
    const { noteEl } = buildSceneInto(getByTestId('container'))
    const ev = fireContextMenu(noteEl, { ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('right-click empty staff area → measure target opens the menu + selects the bar', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    const { getByTestId } = render(<Harness enabled />)
    const container = getByTestId('container')
    buildSceneInto(container)
    const staff = container.querySelector('.abcjs-staff') as Element
    const ev = fireContextMenu(staff)
    expect(ev.defaultPrevented).toBe(true)
    expect(useChatStore.getState().contextMenu?.target.kind).toBe('measure')
    expect(useChatStore.getState().measureRangeSelection).toEqual({ fromStart: 0, fromEnd: 0 })
  })

  it('right-click a staff with no tagged events → empty → native menu', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    const { getByTestId } = render(<Harness enabled />)
    const container = getByTestId('container')
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
    const system = document.createElementNS(NS, 'g')
    system.setAttribute('class', 'abcjs-staff-wrapper')
    svg.appendChild(system)
    const staff = document.createElementNS(NS, 'g')
    staff.setAttribute('class', 'abcjs-staff')
    stubRect(staff, { left: 0, right: 400, top: 0, bottom: 100 })
    system.appendChild(staff)
    container.appendChild(svg)
    const ev = fireContextMenu(staff)
    expect(ev.defaultPrevented).toBe(false)
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('ContextMenu key opens the menu for the current selection at its anchor', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    useChatStore.setState({
      editedScore: score,
      selection: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, anchorX: 120, anchorY: 80 },
    })
    render(<Harness enabled />)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
    const cm = useChatStore.getState().contextMenu
    expect(cm?.target.kind).toBe('note')
    expect(cm?.anchorX).toBe(120)
  })

  it('Shift+F10 with no selection is a no-op (leaves the native menu)', () => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_MENU = 'on'
    useChatStore.setState({ editedScore: score, selection: undefined, measureRangeSelection: undefined })
    render(<Harness enabled />)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })
})
