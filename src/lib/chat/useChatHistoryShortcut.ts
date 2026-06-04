'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/chat/state'

/**
 * Global keyboard shortcut for the chat history panel:
 *  - Ctrl/Cmd + /  → toggle
 *  - Escape        → close (only when the panel is open)
 *
 * Attached to `document` (not the score-stage ref like
 * `useEditorKeyboard`) so it works while the user is typing in
 * PromptBar or any other input. Other Escape consumers (CheatSheet,
 * NoteFloatingMenu) gate their own handlers on their own open-state so
 * there's no double-handling.
 */
export function useChatHistoryShortcut() {
  const panelOpen = useChatStore((s) => s.panelOpen)
  const togglePanel = useChatStore((s) => s.togglePanel)
  const setPanelOpen = useChatStore((s) => s.setPanelOpen)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault()
        togglePanel()
        return
      }
      if (e.key === 'Escape' && panelOpen) {
        setPanelOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panelOpen, togglePanel, setPanelOpen])
}
