'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * SSR-safe reactive `window.matchMedia` hook.
 *
 * `useSyncExternalStore` avoids the "setState in effect" anti-pattern and gives
 * correct hydration: the server snapshot is `false` (matching a no-offset/
 * mobile-first default), the client snapshot is the live `mql.matches` at
 * hydration time, and the component re-renders on every breakpoint crossing.
 *
 * Pair with the `mq` helpers from `./breakpoints` for a canonical query string,
 * e.g. `useMatchMedia(mq.up('lg'))`.
 *
 * Extracted from ChatHistoryPanel (M-series) so SessionSidebar and future
 * call-sites share one implementation.
 */
export function useMatchMedia(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined') return () => {}
      const mql = window.matchMedia(query)
      // addEventListener is the modern API; the addListener fallback covers
      // older Safari where MediaQueryList isn't an EventTarget.
      if (mql.addEventListener) {
        mql.addEventListener('change', notify)
        return () => mql.removeEventListener('change', notify)
      }
      mql.addListener(notify)
      return () => mql.removeListener(notify)
    },
    [query],
  )
  const getSnapshot = useCallback(
    () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
    [query],
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
