import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { usePinchZoom } from '@/components/editor/usePinchZoom'
import { touchGestureBus } from '@/components/editor/touchGestureBus'
import { useEditorPrefsStore } from '@/lib/editor/prefsStore'
import { firePointer } from '../../../helpers/pointer'

/**
 * Two-finger pinch maps the pointer-distance ratio onto the ZOOM_LEVELS ladder:
 * desiredZoom = startZoom × (currentDist / startDist), snapped to the nearest
 * rung. Also pins the drag-arbitration contract (pinchActive set/cleared).
 */

let el: HTMLDivElement

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  useEditorPrefsStore.setState({ zoom: 1.0 })
  touchGestureBus.reset()
})

afterEach(() => {
  document.body.innerHTML = ''
  touchGestureBus.reset()
})

function mount() {
  renderHook(() => {
    const ref = useRef<HTMLElement | null>(el)
    usePinchZoom(ref, true)
  })
}

const P1 = { pointerId: 1, pointerType: 'touch' as const }
const P2 = { pointerId: 2, pointerType: 'touch' as const, isPrimary: false }

describe('usePinchZoom', () => {
  it('marks pinchActive once two fingers are down, clears it on lift', () => {
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    expect(touchGestureBus.isPinchActive()).toBe(false)
    firePointer(el, 'pointerdown', { ...P2, clientX: 200, clientY: 100 })
    expect(touchGestureBus.isPinchActive()).toBe(true)
    firePointer(el, 'pointerup', { ...P2, clientX: 200, clientY: 100 })
    expect(touchGestureBus.isPinchActive()).toBe(false)
  })

  it('spreading the fingers (ratio 2×) zooms toward 2.0', () => {
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    firePointer(el, 'pointerdown', { ...P2, clientX: 200, clientY: 100 }) // startDist = 100
    firePointer(el, 'pointermove', { ...P2, clientX: 300, clientY: 100 }) // dist = 200 → ratio 2
    expect(useEditorPrefsStore.getState().zoom).toBe(2.0)
  })

  it('pinching the fingers together zooms out', () => {
    useEditorPrefsStore.setState({ zoom: 2.0 })
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    firePointer(el, 'pointerdown', { ...P2, clientX: 300, clientY: 100 }) // startDist = 200, startZoom 2.0
    firePointer(el, 'pointermove', { ...P2, clientX: 200, clientY: 100 }) // dist 100 → ratio 0.5 → 1.0
    expect(useEditorPrefsStore.getState().zoom).toBe(1.0)
  })

  it('ignores a single finger (no pinch, no zoom change)', () => {
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    firePointer(el, 'pointermove', { ...P1, clientX: 400, clientY: 100 })
    expect(touchGestureBus.isPinchActive()).toBe(false)
    expect(useEditorPrefsStore.getState().zoom).toBe(1.0)
  })

  it('snaps to the nearest ladder rung (1.3× ≈ stays/steps by one)', () => {
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    firePointer(el, 'pointerdown', { ...P2, clientX: 200, clientY: 100 }) // startDist 100, startZoom 1.0
    firePointer(el, 'pointermove', { ...P2, clientX: 230, clientY: 100 }) // dist 130 → 1.3 → nearest 1.25
    expect(useEditorPrefsStore.getState().zoom).toBe(1.25)
  })

  it('re-baselines and stays active when a third finger lifts back to two', () => {
    const P3 = { pointerId: 3, pointerType: 'touch' as const, isPrimary: false }
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    firePointer(el, 'pointerdown', { ...P2, clientX: 200, clientY: 100 })
    firePointer(el, 'pointerdown', { ...P3, clientX: 300, clientY: 100 })
    firePointer(el, 'pointerup', { ...P3, clientX: 300, clientY: 100 }) // back to 2 → re-baseline
    expect(touchGestureBus.isPinchActive()).toBe(true)
    // A spread from the new baseline still zooms (not frozen).
    firePointer(el, 'pointermove', { ...P2, clientX: 300, clientY: 100 }) // 100→200 = 2×
    expect(useEditorPrefsStore.getState().zoom).toBe(2.0)
  })

  it('a fresh single touch clears a stuck pinchActive (self-heal)', () => {
    touchGestureBus.setPinchActive(true) // simulate a missed pointerup
    mount()
    firePointer(el, 'pointerdown', { ...P1, clientX: 100, clientY: 100 })
    expect(touchGestureBus.isPinchActive()).toBe(false)
  })
})
