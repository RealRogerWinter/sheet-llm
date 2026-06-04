import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useCommandPalette } from '@/components/editor/useCommandPalette'

afterEach(() => cleanup())

function fireKey(key: string, options: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    ctrlKey: options.ctrl ?? false,
    metaKey: options.meta ?? false,
    shiftKey: options.shift ?? false,
    altKey: options.alt ?? false,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(e)
}

describe('useCommandPalette — open trigger', () => {
  it('fires onOpen when Ctrl+K is pressed', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('k', { ctrl: true }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('fires onOpen when Meta+K (Mac) is pressed', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('k', { meta: true }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('handles uppercase K (shift-lock or capital K key event)', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('K', { ctrl: true }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('useCommandPalette — modifier guards', () => {
  it('does NOT fire on bare K (no modifier)', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('k'))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does NOT fire on Shift+K (volta popover keybind reserved)', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('K', { shift: true }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does NOT fire on Ctrl+Shift+K (reserved for future combo)', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('K', { ctrl: true, shift: true }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does NOT fire on Ctrl+Alt+K', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('K', { ctrl: true, alt: true }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does NOT fire on non-K keys with Ctrl held', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    act(() => fireKey('j', { ctrl: true }))
    act(() => fireKey('p', { ctrl: true }))
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('useCommandPalette — cleanup', () => {
  it('removes the listener on unmount', () => {
    const onOpen = vi.fn()
    const { unmount } = renderHook(() => useCommandPalette(onOpen))
    unmount()
    act(() => fireKey('k', { ctrl: true }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('uses a fresh onOpen on each fire (ref pattern)', () => {
    let count = 0
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useCommandPalette(cb), {
      initialProps: { cb: () => { count = 1 } },
    })
    rerender({ cb: () => { count = 2 } })
    act(() => fireKey('k', { ctrl: true }))
    expect(count).toBe(2)
  })
})

describe('useCommandPalette — capture-phase semantics', () => {
  it('preventDefault is called so the browser does not act on Ctrl+K (e.g. focus address bar)', () => {
    const onOpen = vi.fn()
    renderHook(() => useCommandPalette(onOpen))
    const e = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    const pd = vi.spyOn(e, 'preventDefault')
    act(() => { document.dispatchEvent(e) })
    expect(pd).toHaveBeenCalled()
  })
})
