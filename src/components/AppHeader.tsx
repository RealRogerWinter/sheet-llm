'use client'

import { useEffect, useRef } from 'react'
import HelpButton from './HelpButton'
import ImportScoreButton from './ImportScoreButton'
import NewMenu from './NewMenu'
import SessionsButton from './SessionsButton'
import ThemeToggle from './ThemeToggle'
import UsageCounter from './UsageCounter'
import AuthNavButton from './auth/AuthNavButton'
import HeaderMenu from './HeaderMenu'
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

  return (
    <header ref={ref} className={styles.header}>
      <SessionsButton />
      <h1 className={styles.brand}>sheet-llm</h1>
      <div className={styles.right}>
        <ImportScoreButton />
        <NewMenu />
        <UsageCounter />
        <HelpButton />
        <ThemeToggle />
        <AuthNavButton />
        <HeaderMenu />
      </div>
    </header>
  )
}
