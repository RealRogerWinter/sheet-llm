'use client'

import { useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { createBlankScore } from './import/createBlankScore'
import styles from './NewScoreButton.module.css'

/**
 * Creates a fresh editable score with no LLM round-trip. Sits left of
 * `NewScoreButton` ("+ New from prompt") in the header. Single-document
 * app — if a score is already loaded, confirms before replacing.
 */
export default function BlankScoreButton() {
  const abc = useChatStore((s) => s.abc)
  const chatId = useChatStore((s) => s.chatId)
  const pending = useChatStore((s) => s.pending)
  const [inFlight, setInFlight] = useState(false)

  const hasContent = Boolean(abc || chatId)
  const disabled = pending || inFlight

  async function onClick() {
    if (hasContent && typeof window !== 'undefined') {
      const ok = window.confirm(
        'Start a blank score? The current conversation will be cleared.',
      )
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
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      disabled={disabled}
      aria-label="Start a blank score and begin composing"
    >
      <span className={styles.plus} aria-hidden="true">+</span> Blank score
    </button>
  )
}
