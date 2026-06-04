'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './Coachmark.module.css'

const STORAGE_KEY = 'sheet-llm.coachmark-dismissed'

export default function Coachmark() {
  const abc = useChatStore((s) => s.abc)
  // Lazy initializer: read localStorage on first client render.
  // On the server this returns true so no coachmark renders in SSR.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  })
  const [anchor, setAnchor] = useState<{ left: number; top: number } | undefined>(undefined)

  // Position anchor below the first note once a score is rendered.
  useEffect(() => {
    if (dismissed || !abc) return
    let cancelled = false
    function tryPosition(attempt = 0) {
      if (cancelled) return
      const firstNote = document.querySelector('main .abcjs-note') as SVGGraphicsElement | null
      if (!firstNote) {
        if (attempt < 20) setTimeout(() => tryPosition(attempt + 1), 100)
        return
      }
      const rect = firstNote.getBoundingClientRect()
      setAnchor({
        left: Math.max(16, Math.min(rect.left + rect.width / 2 - 130, window.innerWidth - 296)),
        top: rect.bottom + window.scrollY + 14,
      })
    }
    tryPosition()
    return () => {
      cancelled = true
    }
  }, [abc, dismissed])

  // Auto-dismiss after 8 seconds.
  useEffect(() => {
    if (dismissed || !anchor) return
    const t = setTimeout(() => {
      setDismissed(true)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, '1')
      }
    }, 8_000)
    return () => clearTimeout(t)
  }, [dismissed, anchor])

  function doDismiss() {
    setDismissed(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, '1')
    }
  }

  if (dismissed || !anchor || !abc) return null

  return (
    <div className={styles.coachmark} style={{ left: anchor.left, top: anchor.top }} role="dialog">
      <span className={styles.tip} aria-hidden="true" />
      <div>Click any note to edit. Click an empty staff position to add a note — same beat as an existing note stacks them into a chord. Press <strong>c</strong> for the chord palette, <strong>?</strong> for all shortcuts.</div>
      <div className={styles.actions}>
        <button type="button" className={styles.dismiss} onClick={doDismiss}>
          Got it
        </button>
      </div>
    </div>
  )
}
