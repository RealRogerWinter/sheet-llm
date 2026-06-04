'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './ChatHistoryButton.module.css'

/**
 * Header trigger for the chat history panel. Shows a turn-count badge
 * once turns exist; pulses once after the first response so first-time
 * users notice the panel exists.
 */
export default function ChatHistoryButton() {
  const panelOpen = useChatStore((s) => s.panelOpen)
  const togglePanel = useChatStore((s) => s.togglePanel)
  const turnCount = useChatStore((s) => s.turns.length)

  const [shouldPulse, setShouldPulse] = useState(false)
  const previousCountRef = useRef(turnCount)
  const hasPulsedRef = useRef(false)

  useEffect(() => {
    const prev = previousCountRef.current
    previousCountRef.current = turnCount
    // First assistant turn arrives → pulse once, only if panel is closed
    // (no need to draw attention to a panel they can already see).
    if (!hasPulsedRef.current && prev === 1 && turnCount === 2 && !panelOpen) {
      hasPulsedRef.current = true
      setShouldPulse(true)
      const id = window.setTimeout(() => setShouldPulse(false), 2400)
      return () => window.clearTimeout(id)
    }
  }, [turnCount, panelOpen])

  return (
    <button
      type="button"
      className={`${styles.button} ${shouldPulse ? styles.pulse : ''}`}
      onClick={togglePanel}
      aria-expanded={panelOpen}
      aria-controls="chat-history-panel"
      aria-keyshortcuts="Control+/ Meta+/"
      aria-label={
        panelOpen
          ? 'Close conversation panel'
          : turnCount > 0
            ? `Open conversation panel — ${turnCount} ${turnCount === 1 ? 'turn' : 'turns'}`
            : 'Open conversation panel'
      }
    >
      <span aria-hidden="true" className={styles.icon}>
        {/* Simple chat bubble glyph in --ink. */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 3.5h10v6H6.5L4 12V9.5H2v-6z" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </span>
      <span>Conversation</span>
      {turnCount > 0 && (
        <span className={styles.badge} aria-hidden="true">
          {turnCount}
        </span>
      )}
    </button>
  )
}
