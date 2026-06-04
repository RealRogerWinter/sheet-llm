import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ScoreZoomBar from '@/components/ScoreZoomBar'
import {
  DEFAULT_ZOOM,
  useEditorPrefsStore,
  ZOOM_LEVELS,
} from '@/lib/editor/prefsStore'

beforeEach(() => {
  useEditorPrefsStore.setState({ zoom: DEFAULT_ZOOM })
  cleanup()
})

describe('<ScoreZoomBar />', () => {
  it('renders the current zoom as a percentage', () => {
    useEditorPrefsStore.setState({ zoom: 1.5 })
    render(<ScoreZoomBar />)
    expect(screen.getByText('150%')).toBeInTheDocument()
  })

  it('clicking + steps zoom up one rung', () => {
    render(<ScoreZoomBar />)
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(useEditorPrefsStore.getState().zoom).toBe(1.25)
  })

  it('clicking − steps zoom down one rung', () => {
    render(<ScoreZoomBar />)
    fireEvent.click(screen.getByLabelText('Zoom out'))
    expect(useEditorPrefsStore.getState().zoom).toBe(0.75)
  })

  it('clicking the percentage label resets to 100% when non-default', () => {
    useEditorPrefsStore.setState({ zoom: 2.0 })
    render(<ScoreZoomBar />)
    fireEvent.click(screen.getByText('200%'))
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
  })

  it('zoom-out is disabled at the bottom of the ladder', () => {
    useEditorPrefsStore.setState({ zoom: ZOOM_LEVELS[0] })
    render(<ScoreZoomBar />)
    expect(screen.getByLabelText('Zoom out')).toBeDisabled()
    expect(screen.getByLabelText('Zoom in')).not.toBeDisabled()
  })

  it('zoom-in is disabled at the top of the ladder', () => {
    useEditorPrefsStore.setState({ zoom: ZOOM_LEVELS[ZOOM_LEVELS.length - 1] })
    render(<ScoreZoomBar />)
    expect(screen.getByLabelText('Zoom in')).toBeDisabled()
    expect(screen.getByLabelText('Zoom out')).not.toBeDisabled()
  })

  it('reset label is aria-disabled but still focusable at 100%', () => {
    // Keeping the button focusable (and clicks a safe no-op) avoids a
    // focus trap when the user clicks reset: disabling would drop
    // focus silently to <body>. resetZoom in the store already
    // no-ops at default, so the aria-disabled label is honest.
    render(<ScoreZoomBar />)
    const label = screen.getByText('100%')
    expect(label).not.toBeDisabled()
    expect(label.getAttribute('aria-disabled')).toBe('true')
  })

  it('clicking reset at 100% is a no-op (focus stays put)', () => {
    render(<ScoreZoomBar />)
    fireEvent.click(screen.getByText('100%'))
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
  })
})
