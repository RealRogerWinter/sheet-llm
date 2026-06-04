import { describe, it, expect, beforeEach } from 'vitest'
import { useRef } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useScoreWheelZoom } from '@/components/editor/useScoreWheelZoom'
import { DEFAULT_ZOOM, useEditorPrefsStore } from '@/lib/editor/prefsStore'

function Harness({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useScoreWheelZoom(ref, enabled)
  return <div ref={ref} data-testid="area" />
}

const zoom = () => useEditorPrefsStore.getState().zoom

beforeEach(() => {
  useEditorPrefsStore.setState({ zoom: DEFAULT_ZOOM })
  cleanup()
})

describe('useScoreWheelZoom', () => {
  it('Ctrl + wheel up zooms in AND prevents the browser default', () => {
    const { getByTestId } = render(<Harness />)
    // fireEvent returns false when the event was canceled (preventDefault
    // fired) — that's how we know the native page zoom is suppressed.
    const notCanceled = fireEvent.wheel(getByTestId('area'), { deltaY: -100, ctrlKey: true })
    expect(notCanceled).toBe(false)
    expect(zoom()).toBe(1.25)
  })

  it('Ctrl + wheel down zooms out', () => {
    const { getByTestId } = render(<Harness />)
    fireEvent.wheel(getByTestId('area'), { deltaY: 100, ctrlKey: true })
    expect(zoom()).toBe(0.75)
  })

  it('⌘ (metaKey) + wheel up zooms in (Mac path)', () => {
    const { getByTestId } = render(<Harness />)
    fireEvent.wheel(getByTestId('area'), { deltaY: -100, metaKey: true })
    expect(zoom()).toBe(1.25)
  })

  it('plain wheel (no modifier) does NOT zoom and stays scrollable', () => {
    const { getByTestId } = render(<Harness />)
    const notCanceled = fireEvent.wheel(getByTestId('area'), { deltaY: -100 })
    // Default NOT prevented → the page/score still scrolls vertically.
    expect(notCanceled).toBe(true)
    expect(zoom()).toBe(DEFAULT_ZOOM)
  })

  it('accumulates sub-threshold deltas into a single ladder step', () => {
    const { getByTestId } = render(<Harness />)
    const el = getByTestId('area')
    fireEvent.wheel(el, { deltaY: -50, ctrlKey: true }) // accum -50: no step yet
    expect(zoom()).toBe(DEFAULT_ZOOM)
    fireEvent.wheel(el, { deltaY: -50, ctrlKey: true }) // accum -100: one step
    expect(zoom()).toBe(1.25)
  })

  it('normalizes line-mode deltas (deltaMode 1) so a mouse "lines" wheel still steps', () => {
    const { getByTestId } = render(<Harness />)
    // 7 lines × 16px ≈ 112px ≥ threshold → one step.
    fireEvent.wheel(getByTestId('area'), { deltaY: -7, deltaMode: 1, ctrlKey: true })
    expect(zoom()).toBe(1.25)
  })

  it('does nothing when disabled (no score present)', () => {
    const { getByTestId } = render(<Harness enabled={false} />)
    fireEvent.wheel(getByTestId('area'), { deltaY: -100, ctrlKey: true })
    expect(zoom()).toBe(DEFAULT_ZOOM)
  })
})
