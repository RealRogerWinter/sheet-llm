'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import styles from './HeaderMenu.module.css'

const GITHUB_URL = 'https://github.com/RealRogerWinter/sheet-llm'

/**
 * Far-right "⋮" overflow menu in the app header. Always offers the GitHub
 * link; offers Terms of Service + Privacy Policy only when those pages are
 * live (the SL_LEGAL_* operator details are configured), fetched at runtime
 * from /api/legal so this stays correct without making the header dynamic.
 * Mirrors transport/OverflowMenu's open/outside-click/Escape mechanics.
 */
export default function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const [legalEnabled, setLegalEnabled] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/legal')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => {
        if (active) setLegalEnabled(Boolean(d?.enabled))
      })
      .catch(() => {
        /* leave links hidden on error */
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
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
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.button}
        onClick={() => setOpen((v) => !v)}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
      >
        <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="More">
          {legalEnabled && (
            <>
              <Link href="/terms" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
                Terms of Service
              </Link>
              <Link href="/privacy" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
                Privacy Policy
              </Link>
            </>
          )}
          <a
            href={GITHUB_URL}
            role="menuitem"
            className={styles.item}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            GitHub
          </a>
        </div>
      )}
    </div>
  )
}
