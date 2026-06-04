import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMatchMedia } from '@/lib/ui/useMatchMedia'

/**
 * Minimal controllable matchMedia mock — jsdom doesn't implement matchMedia,
 * so we install one that lets the test flip `matches` and fire a `change`.
 */
function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    // legacy fallback path
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
  }
  const matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia
  vi.stubGlobal('matchMedia', matchMedia)
  return {
    mql,
    fire: (next: boolean) => {
      mql.matches = next
      listeners.forEach((cb) => cb())
    },
    listenerCount: () => listeners.size,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useMatchMedia', () => {
  it('returns the initial matchMedia result', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useMatchMedia('(min-width: 1024px)'))
    expect(result.current).toBe(true)
  })

  it('re-renders when the media query crosses its breakpoint', () => {
    const mm = installMatchMedia(false)
    const { result } = renderHook(() => useMatchMedia('(min-width: 1280px)'))
    expect(result.current).toBe(false)
    act(() => mm.fire(true))
    expect(result.current).toBe(true)
    act(() => mm.fire(false))
    expect(result.current).toBe(false)
  })

  it('detaches its change listener on unmount', () => {
    const mm = installMatchMedia(false)
    const { unmount } = renderHook(() => useMatchMedia('(max-width: 767px)'))
    expect(mm.listenerCount()).toBe(1)
    unmount()
    expect(mm.listenerCount()).toBe(0)
  })
})
