'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './SessionsButton.module.css'

const DESKTOP_BREAKPOINT = '(min-width: 1024px)'

/**
 * Header trigger for the sessions sidebar. Toggles the mobile drawer
 * (<1024px) or the desktop collapsed state (>=1024px), picking the
 * right state at click time via matchMedia so we don't need duplicate
 * buttons or media-query effects to wire up the default.
 */
export default function SessionsButton() {
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const toggleSidebarCollapsed = useChatStore((s) => s.toggleSidebarCollapsed)

  // matchMedia can't run during SSR or the first client render (would
  // hydration-mismatch). Default to mobile semantics — same as the
  // store's initial `sidebarOpen=false` — and re-resolve in an effect.
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_BREAKPOINT)
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  function onClick() {
    if (typeof window === 'undefined') return
    const isDesktopNow = window.matchMedia(DESKTOP_BREAKPOINT).matches
    if (isDesktopNow) toggleSidebarCollapsed()
    else toggleSidebar()
  }

  const expanded = isDesktop ? !sidebarCollapsed : sidebarOpen

  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls="session-sidebar"
      aria-label={expanded ? 'Close sessions' : 'Open sessions'}
    >
      <span aria-hidden="true" className={styles.icon}>
        {/* Hamburger glyph. */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 3.5h10M2 7h10M2 10.5h10" strokeLinecap="round" />
        </svg>
      </span>
      <span>Sessions</span>
    </button>
  )
}
