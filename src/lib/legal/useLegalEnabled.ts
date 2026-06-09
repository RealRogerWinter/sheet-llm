'use client'

import { useEffect, useState } from 'react'

/**
 * Whether the legal pages (Terms of Service / Privacy Policy) are live — i.e.
 * the operator has configured the `SL_LEGAL_*` details. Sourced from
 * `GET /api/legal` so it stays correct without making the header dynamic.
 *
 * The fetch is **memoized at module scope**: the request fires at most once per
 * page load no matter how many components consume the hook. The app header now
 * has two consumers — the desktop `HeaderMenu` (⋮) and the mobile `MobileNav`
 * (☰) — and both are mounted (one is CSS-hidden per breakpoint), so without
 * this cache they would each hit `/api/legal` independently and could race to
 * out-of-order results. One shared in-flight promise removes both problems.
 */

let cached: Promise<boolean> | null = null

function fetchLegalEnabled(): Promise<boolean> {
  if (cached) return cached
  cached = fetch('/api/legal')
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .then((d) => Boolean(d?.enabled))
    .catch(() => {
      // Network/parse error: leave links hidden AND drop the cache so a later
      // mount can retry rather than being pinned to the failed result.
      cached = null
      return false
    })
  return cached
}

export function useLegalEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let active = true
    void fetchLegalEnabled().then((value) => {
      if (active) setEnabled(value)
    })
    return () => {
      active = false
    }
  }, [])

  return enabled
}
