import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useStaffInteractions } from '@/components/editor/useStaffInteractions'
import { useChatStore } from '@/lib/chat/state'
import { touchGestureBus } from '@/components/editor/touchGestureBus'
import type { Score } from '@/lib/music/types'
import { firePointer } from '../../../helpers/pointer'

/**
 * useStaffInteractions migrated from mouse events to pointer events (responsive
 * PR-4) so tap-to-place works on touch. These tests pin the pointer plumbing on
 * the deselect branch (reachable without the full insert geometry): a primary
 * tap with a selection present deselects; a drag (travel > tolerance) does not;
 * a non-primary pointer is ignored; an outside tap deselects.
 */

const ONE_BAR_SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
}

const SELECTION = { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 }

afterEach(() => {
  document.body.innerHTML = ''
  touchGestureBus.reset()
  vi.restoreAllMocks()
})

function seed(withSelection: boolean): { container: HTMLDivElement; svg: SVGSVGElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  const staff = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  staff.setAttribute('class', 'abcjs-staff')
  svg.appendChild(staff)
  container.appendChild(svg)
  useChatStore.setState({
    editedScore: ONE_BAR_SCORE,
    selection: withSelection ? SELECTION : undefined,
  } as Partial<ReturnType<typeof useChatStore.getState>> as never)
  return { container, svg }
}

function mount(container: HTMLDivElement) {
  renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(container)
    useStaffInteractions(ref)
  })
}

describe('useStaffInteractions — pointer migration', () => {
  it('a primary tap on empty staff with a selection deselects', () => {
    const { container, svg } = seed(true)
    mount(container)
    firePointer(svg, 'pointerdown', { clientX: 500, clientY: 120 })
    firePointer(svg, 'pointerup', { clientX: 500, clientY: 120 })
    expect(useChatStore.getState().selection).toBeUndefined()
  })

  it('a drag (travel > tolerance) does NOT deselect', () => {
    const { container, svg } = seed(true)
    mount(container)
    firePointer(svg, 'pointerdown', { clientX: 500, clientY: 120 })
    firePointer(svg, 'pointerup', { clientX: 500, clientY: 160 }) // 40px travel
    expect(useChatStore.getState().selection).toEqual(SELECTION)
  })

  it('ignores a non-primary pointer (e.g. second finger of a pinch)', () => {
    const { container, svg } = seed(true)
    mount(container)
    firePointer(svg, 'pointerdown', { clientX: 500, clientY: 120 })
    firePointer(svg, 'pointerup', { clientX: 500, clientY: 120, isPrimary: false })
    expect(useChatStore.getState().selection).toEqual(SELECTION)
  })

  it('a pointerdown outside the container deselects', () => {
    const { container } = seed(true)
    mount(container)
    firePointer(document.body, 'pointerdown', { clientX: 5, clientY: 5 })
    expect(useChatStore.getState().selection).toBeUndefined()
  })

  it('while range-armed, a tap that resolves no bar finishes (disarms) and does not insert', () => {
    const { container, svg } = seed(false)
    mount(container)
    touchGestureBus.armRange()
    // The bare seed SVG has no SourceMap geometry, so the tap resolves no
    // measure → the armed branch disarms and returns without inserting.
    firePointer(svg, 'pointerdown', { clientX: 500, clientY: 120 })
    firePointer(svg, 'pointerup', { clientX: 500, clientY: 120 })
    expect(touchGestureBus.isRangeArmed()).toBe(false)
  })

  it('an outside press also ends a range-select session', () => {
    const { container } = seed(false)
    mount(container)
    touchGestureBus.armRange()
    firePointer(document.body, 'pointerdown', { clientX: 5, clientY: 5 })
    expect(touchGestureBus.isRangeArmed()).toBe(false)
  })
})
