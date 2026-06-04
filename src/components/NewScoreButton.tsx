'use client'

import { useChatStore } from '@/lib/chat/state'
import styles from './NewScoreButton.module.css'

export default function NewScoreButton() {
  const reset = useChatStore((s) => s.reset)
  const abc = useChatStore((s) => s.abc)
  const chatId = useChatStore((s) => s.chatId)
  const pending = useChatStore((s) => s.pending)

  const hasContent = Boolean(abc || chatId)

  async function onClick() {
    if (hasContent && typeof window !== 'undefined') {
      const ok = window.confirm(
        'Clear this conversation and start over from a prompt?',
      )
      if (!ok) return
    }
    await reset()
  }

  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      disabled={pending || !hasContent}
      aria-label="Clear the current conversation and return to the prompt"
      title="Clear the current conversation and start over from a prompt"
    >
      <span className={styles.plus} aria-hidden="true">+</span> New from prompt
    </button>
  )
}
