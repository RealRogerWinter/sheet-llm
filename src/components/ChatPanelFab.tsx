'use client'

import { useChatStore } from '@/lib/chat/state'
import { mq } from '@/lib/ui/breakpoints'
import { useMatchMedia } from '@/lib/ui/useMatchMedia'
import styles from './ChatPanelFab.module.css'

// Mirror ChatHistoryPanel's dock breakpoint: at >=1280px the panel is a
// permanent docked sidebar, so the FAB (a reach-the-panel affordance for
// the touch/overlay modes) must NOT show there.
const DOCK_BREAKPOINT = mq.up('xl')

/**
 * Floating action button that opens the conversation panel on
 * touch / narrow viewports (drawer + sheet modes, <1280px).
 *
 * PR #65 removed the header `ChatHistoryButton`, leaving the panel
 * reachable only via Ctrl/⌘+/ and the ⌘K palette — both keyboard-only.
 * This restores a pointer-activatable open control, anchored bottom-right
 * above the PromptBar, carrying the same a11y semantics the header button
 * had (aria-controls / aria-expanded / aria-keyshortcuts / labelled with
 * the turn count). The Ctrl+/ and palette toggles still work alongside it.
 *
 * Render gate mirrors the panel's own (`ChatHistoryPanel`): only when a
 * score exists AND there is conversation to show. It also hides while the
 * panel is open (the panel's own close button + grabber take over) and in
 * docked mode (the panel is always visible there — no toggle needed).
 */
export default function ChatPanelFab() {
  const abc = useChatStore((s) => s.abc)
  const turnCount = useChatStore((s) => s.turns.length)
  const panelOpen = useChatStore((s) => s.panelOpen)
  const togglePanel = useChatStore((s) => s.togglePanel)
  const isDocked = useMatchMedia(DOCK_BREAKPOINT)

  // No score, or no conversation yet → nothing to open. Mirror the panel.
  if (!abc || turnCount === 0) return null
  // Docked: the panel is permanent; a toggle FAB would be meaningless.
  if (isDocked) return null
  // While open, the panel owns its own dismiss affordances — don't stack a
  // FAB on top of it.
  if (panelOpen) return null

  return (
    <button
      type="button"
      className={styles.fab}
      onClick={togglePanel}
      aria-expanded={panelOpen}
      aria-controls="chat-history-panel"
      aria-keyshortcuts="Control+/ Meta+/"
      aria-label={`Open conversation panel — ${turnCount} ${turnCount === 1 ? 'turn' : 'turns'}`}
    >
      <span aria-hidden="true" className={styles.icon}>
        {/* Chat-bubble glyph, matching the deleted ChatHistoryButton. */}
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 3.5h10v6H6.5L4 12V9.5H2v-6z" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </span>
      <span className={styles.count} aria-hidden="true">
        {turnCount}
      </span>
    </button>
  )
}
