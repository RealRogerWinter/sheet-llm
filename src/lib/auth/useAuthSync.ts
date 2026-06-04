'use client'

import { useEffect } from 'react'
import { AUTH_CHANNEL_NAME, refreshSession } from './authClient'

/**
 * Hydrate auth state on mount, then keep it fresh: re-validate when ANOTHER tab
 * broadcasts a login/logout (BroadcastChannel), and when the tab regains
 * visibility (catches a session that expired or was revoked elsewhere). Mount
 * exactly once, in the client shell.
 */
export function useAuthSync(): void {
  useEffect(() => {
    let alive = true
    void refreshSession()

    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel(AUTH_CHANNEL_NAME)
      bc.onmessage = () => {
        if (alive) void refreshSession()
      }
    } catch {
      // BroadcastChannel unsupported — cross-tab sync disabled (best-effort)
    }

    function onVisible() {
      if (alive && document.visibilityState === 'visible') void refreshSession()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      alive = false
      bc?.close()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
