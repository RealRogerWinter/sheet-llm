'use client'

import { useEffect, useRef } from 'react'
import HelpButton from './HelpButton'
import ImportScoreButton from './ImportScoreButton'
import NewMenu from './NewMenu'
import PricingNavButton from './PricingNavButton'
import SessionsButton from './SessionsButton'
import ThemeToggle from './ThemeToggle'
import UsageCounter from './UsageCounter'
import AuthNavButton from './auth/AuthNavButton'
import HeaderMenu from './HeaderMenu'
import MobileNav from './MobileNav'
import Wordmark from './brand/Wordmark'
import styles from './AppHeader.module.css'

export default function AppHeader() {
  const ref = useRef<HTMLElement>(null)

  // Publish the header's real rendered height as --app-header-height so the
  // docked chat panel's top offset and Hero's min-height track it exactly,
  // instead of relying on a hardcoded 73px that breaks when the header wraps
  // on a narrow viewport. ResizeObserver keeps it live across reflows.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const apply = () => root.style.setProperty('--app-header-height', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Responsive split at `lg` (1024px) — the breakpoint SessionsButton and
  // SessionSidebar already use for drawer↔dock, so ONE breakpoint governs the
  // whole left-nav + header system. The split is pure CSS (`.desktopOnly` /
  // `.mobileOnly` in the module): below lg the secondary toolbar collapses into
  // the single MobileNav "☰" menu. CSS `@media` (not JS matchMedia) means the
  // correct layout paints on the first frame — no hydration flash. The wrappers
  // use `display: contents` on desktop so the toolbar is laid out exactly as
  // before (no extra flex box), and `display: none` below lg so the hidden
  // subtree contributes nothing to the header's measured offsetHeight.
  //
  // UsageCounter stays a SINGLE instance in the always-visible slot (shown on
  // both layouts) so its /api/usage fetch never double-fires; MobileNav and
  // HeaderMenu share one memoized /api/legal fetch for the same reason.
  return (
    <header ref={ref} className={styles.header}>
      <SessionsButton />
      <h1 className={styles.brand}>
        <Wordmark size="md" />
      </h1>
      <div className={styles.right}>
        <span className={styles.desktopOnly}>
          <ImportScoreButton />
          <NewMenu />
        </span>
        <UsageCounter />
        <span className={styles.desktopOnly}>
          <HelpButton />
          <PricingNavButton />
          <ThemeToggle />
          <AuthNavButton />
          <HeaderMenu />
        </span>
        <span className={styles.mobileOnly}>
          <MobileNav />
        </span>
      </div>
    </header>
  )
}
