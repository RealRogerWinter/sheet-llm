'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './TransportBar.module.css'

export default function OverflowMenu() {
  const [open, setOpen] = useState(false)
  const followPlayback = useChatStore((s) => s.followPlayback)
  const setFollowPlayback = useChatStore((s) => s.setFollowPlayback)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className={styles.overflowRoot}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => setOpen((v) => !v)}
        aria-label="Playback options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Playback options"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Playback options">
          <label className={styles.menuItem}>
            <input
              type="checkbox"
              checked={followPlayback}
              onChange={(e) => setFollowPlayback(e.target.checked)}
            />
            <span>Follow score</span>
          </label>
          <div className={styles.menuHint}>Scrolls the page to keep the playing note in view.</div>
        </div>
      )}
    </div>
  )
}
