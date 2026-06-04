import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewportRect } from '@/lib/ui/useViewportRect'

function setViewport(width: number, height: number) {
  // jsdom does no layout (documentElement.clientWidth is 0), so the hook falls
  // back to window.innerWidth/Height — drive those.
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

beforeEach(() => {
  // Run rAF synchronously so the throttled notify resolves within act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  setViewport(1024, 768)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useViewportRect', () => {
  it('reads the current viewport size on mount', () => {
    const { result } = renderHook(() => useViewportRect())
    expect(result.current).toEqual({ width: 1024, height: 768 })
  })

  it('updates on window resize', () => {
    const { result } = renderHook(() => useViewportRect())
    act(() => {
      setViewport(390, 844)
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toEqual({ width: 390, height: 844 })
  })

  it('updates on orientationchange', () => {
    const { result } = renderHook(() => useViewportRect())
    act(() => {
      setViewport(844, 390)
      window.dispatchEvent(new Event('orientationchange'))
    })
    expect(result.current).toEqual({ width: 844, height: 390 })
  })

  it('returns a referentially-stable object when size is unchanged', () => {
    const { result, rerender } = renderHook(() => useViewportRect())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
