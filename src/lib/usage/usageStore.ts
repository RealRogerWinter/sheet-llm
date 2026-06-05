'use client'

import { create } from 'zustand'

/** Daily free-request allowance (present only when the hosted quota layer is on). */
export interface UsageDaily {
  remaining: number
  limit: number
  used: number
  resetsInHours: number
}

/** Mirror of the GET /api/usage response. */
export interface UsageSnapshot {
  authenticated: boolean
  tier: string
  daily: UsageDaily | null
  credits: number | null
}

interface UsageState {
  snapshot: UsageSnapshot | null
  /**
   * Re-read GET /api/usage and push it into the store. Best-effort: a failed
   * fetch leaves the prior snapshot in place (the counter just doesn't update),
   * so a transient network blip never blanks the header or throws.
   */
  refresh: () => Promise<void>
}

/**
 * Tiny shared store for the user's remaining allowance, read by both the header
 * `UsageCounter` and the in-chat `LastConfirmationLabel`. `UsageCounter` (always
 * mounted in the header) owns the refresh triggers; everything else just reads
 * `snapshot`.
 */
export const useUsageStore = create<UsageState>((set) => ({
  snapshot: null,
  refresh: async () => {
    try {
      const res = await fetch('/api/usage', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return
      const snapshot = (await res.json()) as UsageSnapshot
      set({ snapshot })
    } catch {
      /* network error — keep the last snapshot */
    }
  },
}))
