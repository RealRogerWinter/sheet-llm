'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '@/lib/chat/state'
import { createBlankScore } from './import/createBlankScore'
import styles from './NewMenu.module.css'

/**
 * Combined "New +" header control. Opens a dropdown offering two ways to
 * start a score:
 *   - "From prompt" → clears the current conversation back to the prompt
 *     input (the former `NewScoreButton` behavior, `reset()`).
 *   - "Blank score" → mints a fresh editable score with no LLM round-trip
 *     (the former `BlankScoreButton` behavior, `createBlankScore()`).
 *
 * Replaces the two standalone header buttons. The single-document app still
 * confirms before clearing existing work. The dropdown is portaled to <body>
 * so it escapes the sticky header's stacking context and sits above the
 * docked side panels (mirrors {@link HeaderMenu}).
 */
export default function NewMenu() {
  const reset = useChatStore((s) => s.reset)
  const abc = useChatStore((s) => s.abc)
  const chatId = useChatStore((s) => s.chatId)
  const pending = useChatStore((s) => s.pending)
  const [open, setOpen] = useState(false)
  const [inFlight, setInFlight] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const hasContent = Boolean(abc || chatId)
  const busy = pending || inFlight

  function toggle() {
    setOpen((wasOpen) => {
      if (!wasOpen && buttonRef.current) {
        const r = buttonRef.current.getBoundingClientRect()
        setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
      }
      return !wasOpen
    })
  }

  // Outside-click + Escape close (mirrors HeaderMenu).
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

  async function onFromPrompt() {
    setOpen(false)
    if (hasContent && typeof window !== 'undefined') {
      const ok = window.confirm('Clear this conversation and start over from a prompt?')
      if (!ok) return
    }
    await reset()
  }

  async function onBlankScore() {
    setOpen(false)
    if (hasContent && typeof window !== 'undefined') {
      const ok = window.confirm('Start a blank score? The current conversation will be cleared.')
      if (!ok) return
    }
    setInFlight(true)
    try {
      const result = await createBlankScore()
      if (!result.ok) {
        // Surface via the existing error toast channel.
        useChatStore.setState({ error: result.error })
      }
    } finally {
      setInFlight(false)
    }
  }

  return (
    <div className={styles.root}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        onClick={toggle}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Create a new score"
        title="Create a new score"
      >
        New <span className={styles.plus} aria-hidden="true">+</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            role="menu"
            aria-label="Create a new score"
            style={{ top: pos.top, right: pos.right }}
          >
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={onFromPrompt}
              disabled={busy || !hasContent}
            >
              From prompt
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={onBlankScore}
              disabled={busy}
            >
              Blank score
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
