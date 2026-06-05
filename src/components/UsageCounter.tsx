'use client'

import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import { useChatStore } from '@/lib/chat/state'
import { useUsageStore } from '@/lib/usage/usageStore'
import styles from './UsageCounter.module.css'

/**
 * Header pill showing the user's remaining allowance — daily free requests for
 * anonymous / non-Pro accounts, or credit balance for Pro. Sourced from
 * GET /api/usage (the single read-only source of truth). Refreshes on mount, on
 * auth-state changes, and whenever a chat generation completes, so the count
 * ticks down live.
 *
 * Renders nothing on self-hosted/local installs where neither the daily-quota
 * layer nor the billing surface is enabled, so the default app is unchanged.
 */
export default function UsageCounter() {
  const snapshot = useUsageStore((s) => s.snapshot)
  const refresh = useUsageStore((s) => s.refresh)
  const authStatus = useAuthStore((s) => s.status)
  const pending = useChatStore((s) => s.pending)
  const prevPending = useRef(pending)

  // Mount + auth-change fetch. Skip while auth is still 'loading' to avoid a
  // throwaway request before the session is known.
  useEffect(() => {
    if (authStatus === 'loading') return
    void refresh()
  }, [authStatus, refresh])

  // A generation just finished (pending true → false): the daily count may have
  // changed, so re-read it.
  useEffect(() => {
    if (prevPending.current && !pending) void refresh()
    prevPending.current = pending
  }, [pending, refresh])

  if (!snapshot) return null

  // Pro (or any billing-enabled authed user with a wallet) → show credits.
  if (snapshot.authenticated && snapshot.credits != null && (snapshot.tier === 'pro' || snapshot.daily == null)) {
    const c = snapshot.credits
    return (
      <span className={styles.pill} title="Your remaining Pro credits" aria-label={`${c} credits remaining`}>
        {c} {c === 1 ? 'credit' : 'credits'}
      </span>
    )
  }

  // Daily free allowance (anonymous / non-Pro).
  if (snapshot.daily) {
    const { remaining, limit, used, resetsInHours } = snapshot.daily
    return (
      <span
        className={`${styles.pill} ${remaining === 0 ? styles.empty : ''}`}
        title={`${used} of ${limit} free daily requests used — resets in about ${resetsInHours}h`}
        aria-label={`${remaining} free daily ${remaining === 1 ? 'use' : 'uses'} left`}
      >
        {remaining} free left
      </span>
    )
  }

  return null
}
