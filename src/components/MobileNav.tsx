'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useChatStore } from '@/lib/chat/state'
import { useAuthStore } from '@/lib/auth/authStore'
import { logout } from '@/lib/auth/authClient'
import { useLegalEnabled } from '@/lib/legal/useLegalEnabled'
import { createBlankScore } from './import/createBlankScore'
import ImportModal from './import/ImportModal'
import HelpModal from './HelpModal'
import styles from './MobileNav.module.css'

const GITHUB_URL = 'https://github.com/RealRogerWinter/sheet-llm'
const THEME_STORAGE_KEY = 'sheet-llm:theme'

/**
 * Consolidated navigation menu for narrow viewports (< lg / 1024px). The header
 * splits at `lg` via pure CSS `@media` (see AppHeader.module.css): the desktop
 * `.right` toolbar is hidden and this single "☰" trigger takes its place,
 * folding every secondary control into one portaled dropdown.
 *
 * Why a dropdown and not a bottom sheet: a sheet (backdrop + slide + focus-trap
 * + body-scroll-lock + safe-area + drag) would over-serve a nav menu and would
 * collide with the SHE-11 chat sheet's own body-scroll-lock. This reuses the
 * established HeaderMenu/NewMenu portal pattern (one paradigm) at
 * `--z-popover` — above the docked panels, below modals — so "close menu, then
 * open modal" is enough to keep stacking correct.
 *
 * Every item mirrors its desktop control's gate exactly, reading the SAME
 * stores (never a cosmetic copy): New's confirm + disabled states, Import's
 * `pending` disable, Auth's loading/disabled/anon/authed branches, the legal
 * links' `/api/legal` gate. Each item closes the menu before acting.
 */
export default function MobileNav() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [inFlight, setInFlight] = useState(false)

  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Chat state — same selectors NewMenu / ImportScoreButton read.
  const reset = useChatStore((s) => s.reset)
  const abc = useChatStore((s) => s.abc)
  const chatId = useChatStore((s) => s.chatId)
  const pending = useChatStore((s) => s.pending)
  const hasContent = Boolean(abc || chatId)
  const busy = pending || inFlight

  // Auth state — same selectors AuthNavButton reads.
  const authStatus = useAuthStore((s) => s.status)
  const email = useAuthStore((s) => s.email)
  const openLogin = useAuthStore((s) => s.openLogin)
  const openSignup = useAuthStore((s) => s.openSignup)

  const legalEnabled = useLegalEnabled()
  const theme = useThemeReadonly()

  // Close + return focus to the trigger (WCAG 2.4.3): the menu is portaled, so
  // closing unmounts the focused item and focus would otherwise fall to <body>.
  // Used by every close path that LEAVES the user on this page (Escape,
  // outside-click, theme/logout, all nav links). Paths that open another
  // surface (Import/Help/Auth modals) use `closeForModal` so focus follows the
  // modal instead.
  const closeAndFocus = useCallback(() => {
    setOpen(false)
    buttonRef.current?.focus()
  }, [])

  function closeForModal() {
    setOpen(false)
  }

  // Anchor the portaled dropdown under the trigger's current rect.
  const reposition = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) })
  }, [])

  function toggle() {
    setOpen((wasOpen) => {
      if (!wasOpen) reposition()
      return !wasOpen
    })
  }

  // Keep the portaled dropdown anchored if the viewport changes while it's open
  // (rotation, mobile address-bar collapse, resize) — pos is otherwise frozen
  // at open time.
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', reposition)
    window.addEventListener('orientationchange', reposition)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('orientationchange', reposition)
    }
  }, [open, reposition])

  // Outside-press + Escape close, both restoring focus to the trigger. We listen
  // on `pointerdown` (not `mousedown` like the desktop HeaderMenu/NewMenu) so a
  // touch tap outside dismisses the menu on phones — this is the mobile control.
  useEffect(() => {
    if (!open) return
    function onDocPointer(e: PointerEvent) {
      const t = e.target as Node
      if (buttonRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      closeAndFocus()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeAndFocus()
      }
    }
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closeAndFocus])

  // Move focus into the menu on open (first item).
  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
    first?.focus()
  }, [open])

  // Roving focus so role="menu" is honest: ↑/↓ between items, Home/End to ends.
  const onMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    )
    if (items.length === 0) return
    e.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    let next = current
    if (e.key === 'ArrowDown') next = current < items.length - 1 ? current + 1 : 0
    else if (e.key === 'ArrowUp') next = current > 0 ? current - 1 : items.length - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    items[next]?.focus()
  }, [])

  // Action wrappers. Destructive New actions CONFIRM FIRST while the menu is
  // still open — a cancelled confirm returns with the menu open and focus
  // intact (closing before the confirm would silently hide the menu and drop
  // focus on cancel). Only after a confirmed/no-confirm-needed action do we
  // closeAndFocus, then run it.
  async function onFromPrompt() {
    if (hasContent && typeof window !== 'undefined') {
      if (!window.confirm('Clear this conversation and start over from a prompt?')) return
    }
    closeAndFocus()
    await reset()
  }

  async function onBlankScore() {
    if (hasContent && typeof window !== 'undefined') {
      if (!window.confirm('Start a blank score? The current conversation will be cleared.')) return
    }
    closeAndFocus()
    setInFlight(true)
    try {
      const result = await createBlankScore()
      if (!result.ok) useChatStore.setState({ error: result.error })
    } finally {
      setInFlight(false)
    }
  }

  // Import/Help open their own modals — focus should follow the modal, so these
  // close WITHOUT returning focus to the trigger.
  function onImport() {
    closeForModal()
    setImportOpen(true)
  }

  function onHelp() {
    closeForModal()
    setHelpOpen(true)
  }

  function onToggleTheme() {
    // Read the live attribute (not the hook value, which is null on the server
    // snapshot) so the toggle always flips relative to the REAL current theme.
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    const next = current === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // localStorage unavailable (private mode / quota) — toggle still works for the session.
    }
    closeAndFocus()
  }

  const showAuth = authStatus === 'anon' || authStatus === 'authed'

  return (
    <div className={styles.root}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        title="Menu"
      >
        {/* Kebab "⋮" — the same affordance as the desktop HeaderMenu this
            replaces, and deliberately NOT a hamburger (SessionsButton already
            owns the hamburger glyph for the sessions drawer). */}
        <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            role="menu"
            aria-label="Navigation"
            style={{ top: pos.top, right: pos.right }}
            onKeyDown={onMenuKeyDown}
          >
            {/* Sections are real ARIA groups (role="group" + aria-labelledby)
                so screen-reader users get the same "Compose / App / Account /
                More" structure sighted users see, instead of a flat 10-item
                list. The label <p> is referenced, not a menuitem, so roving
                focus skips it. */}
            <div role="group" aria-labelledby="mnav-compose">
              <p id="mnav-compose" className={styles.section}>Compose</p>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={onFromPrompt}
                disabled={busy || !hasContent}
              >
                New from prompt
              </button>
              <button type="button" role="menuitem" className={styles.item} onClick={onBlankScore} disabled={busy}>
                New blank score
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={onImport}
                disabled={pending}
              >
                Import a score
              </button>
            </div>

            <div className={styles.rule} role="separator" />
            <div role="group" aria-labelledby="mnav-app">
              <p id="mnav-app" className={styles.section}>App</p>
              <button type="button" role="menuitem" className={styles.item} onClick={onHelp}>
                Help &amp; quick start
              </button>
              <button type="button" role="menuitem" className={styles.item} onClick={onToggleTheme}>
                {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              </button>
              <Link href="/pricing" role="menuitem" className={`${styles.item} ${styles.accent}`} onClick={closeAndFocus}>
                Pricing &amp; credits
              </Link>
            </div>

            {showAuth && (
              <>
                <div className={styles.rule} role="separator" />
                <div role="group" aria-labelledby="mnav-account">
                  <p id="mnav-account" className={styles.section}>Account</p>
                  {authStatus === 'authed' ? (
                    <>
                      <Link href="/settings" role="menuitem" className={styles.item} onClick={closeAndFocus} title={email ?? ''}>
                        {email ?? 'Account'}
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.item}
                        onClick={() => {
                          closeAndFocus()
                          void logout()
                        }}
                      >
                        Log out
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.item}
                        onClick={() => {
                          closeForModal()
                          openLogin()
                        }}
                      >
                        Log in
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.item}
                        onClick={() => {
                          closeForModal()
                          openSignup()
                        }}
                      >
                        Sign up
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            <div className={styles.rule} role="separator" />
            <div role="group" aria-labelledby="mnav-more">
              <p id="mnav-more" className={styles.section}>More</p>
              {legalEnabled && (
                <>
                  <Link href="/terms" role="menuitem" className={styles.item} onClick={closeAndFocus}>
                    Terms of Service
                  </Link>
                  <Link href="/privacy" role="menuitem" className={styles.item} onClick={closeAndFocus}>
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
                onClick={closeAndFocus}
              >
                GitHub
              </a>
            </div>
          </div>,
          document.body,
        )}

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

type Theme = 'light' | 'dark'

/**
 * Reactive read of the current `data-theme` (mirrors ThemeToggle's
 * useSyncExternalStore pattern) so the theme menu item can label the *target*
 * theme. Read-only — the toggle writes `data-theme` + localStorage inline.
 */
function useThemeReadonly(): Theme | null {
  return useSyncExternalStore(
    (cb) => {
      const obs = new MutationObserver(cb)
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      return () => obs.disconnect()
    },
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
    () => null,
  )
}
