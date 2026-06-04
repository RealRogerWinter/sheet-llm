'use client'

import { useCallback, useSyncExternalStore } from 'react'

export interface ViewportRect {
  width: number
  height: number
}

// Stable SSR/zero reference so getServerSnapshot never triggers an infinite
// re-render (useSyncExternalStore compares snapshots by identity).
const SSR_RECT: ViewportRect = { width: 0, height: 0 }

// Module-level memo: getSnapshot MUST return a referentially-stable value while
// the dimensions are unchanged, or React will re-render in a loop. We only mint
// a new object when width/height actually change.
let cached: ViewportRect = SSR_RECT

function readRect(): ViewportRect {
  if (typeof window === 'undefined') return SSR_RECT
  // visualViewport reflects the post-pinch / post-mobile-keyboard layout box;
  // documentElement.clientWidth/Height is the next-best (excludes the scrollbar,
  // unlike window.innerWidth); innerWidth/Height is the final fallback so the
  // value is still meaningful in jsdom, which performs no layout (clientWidth=0).
  const vv = window.visualViewport
  const width = vv?.width || document.documentElement.clientWidth || window.innerWidth
  const height = vv?.height || document.documentElement.clientHeight || window.innerHeight
  // Deliberate, idempotent memo write inside getSnapshot: we only mint a new
  // object when the measured size actually changed, so repeated calls return an
  // identity-stable value (required by useSyncExternalStore to avoid a render
  // loop) while still reflecting live size changes.
  if (width !== cached.width || height !== cached.height) {
    cached = { width, height }
  }
  return cached
}

/**
 * Reactive viewport size, rAF-throttled. Re-renders the consumer whenever the
 * viewport changes — window resize, device rotation, mobile address-bar
 * show/hide, or pinch (via `visualViewport`). Use for overlays that position
 * relative to the viewport (Popover clamp, CommandPalette centering) so they
 * don't go stale after a resize/rotate the way render-time `window.innerWidth`
 * reads do.
 *
 * SSR returns `{ 0, 0 }`; the first client render reads real dimensions
 * synchronously, so client consumers never observe the zero state.
 */
export function useViewportRect(): ViewportRect {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window === 'undefined') return () => {}
    let raf: number | null = null
    const onChange = () => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        notify()
      })
    }
    window.addEventListener('resize', onChange, { passive: true })
    window.addEventListener('orientationchange', onChange, { passive: true })
    const vv = window.visualViewport
    vv?.addEventListener('resize', onChange, { passive: true })
    vv?.addEventListener('scroll', onChange, { passive: true })
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      window.removeEventListener('resize', onChange)
      window.removeEventListener('orientationchange', onChange)
      vv?.removeEventListener('resize', onChange)
      vv?.removeEventListener('scroll', onChange)
    }
  }, [])
  return useSyncExternalStore(subscribe, readRect, () => SSR_RECT)
}
