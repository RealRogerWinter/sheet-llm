import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  canZoomIn,
  canZoomOut,
  DEFAULT_ZOOM,
  NATIVE_STAFFWIDTH,
  staffwidthForZoom,
  useEditorPrefsStore,
  useEditorPrefsSync,
  ZOOM_LEVELS,
} from '@/lib/editor/prefsStore'

function freshStore() {
  useEditorPrefsStore.setState({ zoom: DEFAULT_ZOOM })
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem('sheet-llm:editor:zoom')
    } catch {
      /* ignore */
    }
  }
}

describe('useEditorPrefsStore — zoom', () => {
  beforeEach(freshStore)

  it('starts at DEFAULT_ZOOM (1.0)', () => {
    expect(useEditorPrefsStore.getState().zoom).toBe(1.0)
    expect(DEFAULT_ZOOM).toBe(1.0)
  })

  it('ZOOM_LEVELS is monotonically increasing and includes the default', () => {
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      expect(ZOOM_LEVELS[i]).toBeGreaterThan(ZOOM_LEVELS[i - 1])
    }
    expect(ZOOM_LEVELS).toContain(DEFAULT_ZOOM)
  })

  it('zoomIn steps up by one ladder rung', () => {
    const { zoomIn } = useEditorPrefsStore.getState()
    zoomIn()
    expect(useEditorPrefsStore.getState().zoom).toBe(1.25)
  })

  it('zoomOut steps down by one ladder rung', () => {
    const { zoomOut } = useEditorPrefsStore.getState()
    zoomOut()
    expect(useEditorPrefsStore.getState().zoom).toBe(0.75)
  })

  it('zoomIn at the top of the ladder is a no-op', () => {
    useEditorPrefsStore.setState({ zoom: ZOOM_LEVELS[ZOOM_LEVELS.length - 1] })
    useEditorPrefsStore.getState().zoomIn()
    expect(useEditorPrefsStore.getState().zoom).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1])
  })

  it('zoomOut at the bottom of the ladder is a no-op', () => {
    useEditorPrefsStore.setState({ zoom: ZOOM_LEVELS[0] })
    useEditorPrefsStore.getState().zoomOut()
    expect(useEditorPrefsStore.getState().zoom).toBe(ZOOM_LEVELS[0])
  })

  it('resetZoom returns to DEFAULT_ZOOM', () => {
    useEditorPrefsStore.setState({ zoom: 2.0 })
    useEditorPrefsStore.getState().resetZoom()
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
  })

  it('setZoom persists to localStorage', () => {
    useEditorPrefsStore.getState().setZoom(1.5)
    expect(window.localStorage.getItem('sheet-llm:editor:zoom')).toBe('1.5')
  })

  it('canZoomIn / canZoomOut report ladder bounds', () => {
    expect(canZoomOut(ZOOM_LEVELS[0])).toBe(false)
    expect(canZoomOut(DEFAULT_ZOOM)).toBe(true)
    expect(canZoomIn(ZOOM_LEVELS[ZOOM_LEVELS.length - 1])).toBe(false)
    expect(canZoomIn(DEFAULT_ZOOM)).toBe(true)
  })

  it('walking the ladder from min to max and back returns to min', () => {
    useEditorPrefsStore.setState({ zoom: ZOOM_LEVELS[0] })
    const { zoomIn, zoomOut } = useEditorPrefsStore.getState()
    for (let i = 0; i < ZOOM_LEVELS.length - 1; i++) zoomIn()
    expect(useEditorPrefsStore.getState().zoom).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1])
    for (let i = 0; i < ZOOM_LEVELS.length - 1; i++) zoomOut()
    expect(useEditorPrefsStore.getState().zoom).toBe(ZOOM_LEVELS[0])
  })
})

describe('useEditorPrefsSync — hydration', () => {
  beforeEach(freshStore)

  it('restores a stored non-default ladder value', () => {
    window.localStorage.setItem('sheet-llm:editor:zoom', '1.5')
    renderHook(() => useEditorPrefsSync())
    expect(useEditorPrefsStore.getState().zoom).toBe(1.5)
  })

  it('does NOT call setZoom when stored value equals the default', () => {
    // Matches the useFollowPlaybackSync pattern — hydrating to the
    // current default would re-render every store subscriber for no
    // reason (the store already starts at DEFAULT_ZOOM).
    window.localStorage.setItem('sheet-llm:editor:zoom', String(DEFAULT_ZOOM))
    renderHook(() => useEditorPrefsSync())
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
    // The stored value is unchanged (no setZoom write-back).
    expect(window.localStorage.getItem('sheet-llm:editor:zoom')).toBe(String(DEFAULT_ZOOM))
  })

  it('ignores off-ladder values rather than coerce', () => {
    // 1.1 isn't on the ladder — silently fall back to the in-memory
    // default rather than persist an unsupported value through.
    window.localStorage.setItem('sheet-llm:editor:zoom', '1.1')
    renderHook(() => useEditorPrefsSync())
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
  })

  it('ignores non-numeric stored values', () => {
    window.localStorage.setItem('sheet-llm:editor:zoom', 'not a number')
    renderHook(() => useEditorPrefsSync())
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
  })

  it('does nothing when no stored value is present', () => {
    renderHook(() => useEditorPrefsSync())
    expect(useEditorPrefsStore.getState().zoom).toBe(DEFAULT_ZOOM)
  })
})

describe('staffwidthForZoom — reflow-based zoom mapping', () => {
  it('returns the native screen width at zoom 1.0', () => {
    // zoom 1.0 must reproduce the pre-zoom baseline exactly.
    expect(staffwidthForZoom(1.0)).toBe(NATIVE_STAFFWIDTH)
  })

  it('halves the layout width at 2x zoom (fewer, bigger measures/line)', () => {
    expect(staffwidthForZoom(2.0)).toBe(Math.round(NATIVE_STAFFWIDTH / 2))
  })

  it('doubles the layout width at 0.5x zoom (more, smaller measures/line)', () => {
    expect(staffwidthForZoom(0.5)).toBe(NATIVE_STAFFWIDTH * 2)
  })

  it('is strictly decreasing in zoom across the ladder', () => {
    // Higher zoom ⇒ narrower staffwidth ⇒ the responsive scale-to-fit
    // magnifies the (now fewer) measures per line.
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      expect(staffwidthForZoom(ZOOM_LEVELS[i])).toBeLessThan(
        staffwidthForZoom(ZOOM_LEVELS[i - 1]),
      )
    }
  })

  it('yields a positive integer for every ladder level', () => {
    for (const z of ZOOM_LEVELS) {
      const w = staffwidthForZoom(z)
      expect(Number.isInteger(w)).toBe(true)
      expect(w).toBeGreaterThan(0)
    }
  })
})
