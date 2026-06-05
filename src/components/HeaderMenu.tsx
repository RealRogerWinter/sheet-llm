'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import styles from './HeaderMenu.module.css'

const GITHUB_URL = 'https://github.com/RealRogerWinter/sheet-llm'

/**
 * Far-right "⋮" overflow menu in the app header. Always offers the GitHub
 * link; offers Terms of Service + Privacy Policy only when those pages are
 * live (the SL_LEGAL_* operator details are configured), fetched at runtime
 * from /api/legal so this stays correct without making the header dynamic.
 *
 * The dropdown is rendered through a portal to <body>: the header is
 * `position: sticky; z-index: var(--z-header)`, which creates a stacking
 * context that would otherwise trap the dropdown beneath the docked side
 * panels (--z-panel / --z-ghost-panel). The portal escapes that context so a
 * popover-level z-index actually wins.
 */
export default function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const [legalEnabled, setLegalEnabled] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

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

  function toggle() {
    setOpen((wasOpen) => {
      if (!wasOpen && buttonRef.current) {
        const r = buttonRef.current.getBoundingClientRect()
        setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
      }
      return !wasOpen
    })
  }

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node
      if (buttonRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
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
    <div className={styles.root}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        onClick={toggle}
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
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            role="menu"
            aria-label="More"
            style={{ top: pos.top, right: pos.right }}
          >
            {/* Deliberately ALSO offered here, even though PricingNavButton already
                shows a prominent header button. Pricing is the one upsell surface we
                want maximally discoverable, and this is the natural home for site
                nav (Terms/Privacy/GitHub live here too). The header button can wrap
                off-screen or be overlooked on narrow viewports; the menu is the
                stable fallback. */}
            <Link href="/pricing" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
              Pricing
            </Link>
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
          </div>,
          document.body,
        )}
    </div>
  )
}
