'use client'

import { useEffect } from 'react'
import AppHeader from './AppHeader'
import Hero from './Hero'
import DebugPanel from './DebugPanel'
import ChatHistoryPanel from './ChatHistoryPanel'
import SessionSidebar from './SessionSidebar'
import AuthModal from './auth/AuthModal'
import { GhostPreviewPanel } from './orchestrator/GhostPreviewPanel'
import styles from './AppShell.module.css'
import { mq } from '@/lib/ui/breakpoints'
import { useMatchMedia } from '@/lib/ui/useMatchMedia'
import { useChatIdSession, useChatStore, useFollowPlaybackSync, useReduceMotionSync } from '@/lib/chat/state'
import { useTranscriptSync } from '@/lib/chat/useTranscriptSync'
import { useChatHistoryShortcut } from '@/lib/chat/useChatHistoryShortcut'
import { useEditPersistence } from '@/lib/chat/useEditPersistence'
import { useEditorPrefsSync } from '@/lib/editor/prefsStore'
import { useAuthSync } from '@/lib/auth/useAuthSync'

// Recovery-token interceptor + boot-restore now live in
// `src/components/RecoveryBoot.tsx`, mounted at the root layout level
// so every route (including /settings) gets the wiring.

export default function HomeClient() {
  useChatIdSession()
  useReduceMotionSync()
  useFollowPlaybackSync()
  useEditorPrefsSync()
  useTranscriptSync()
  useChatHistoryShortcut()
  useEditPersistence()
  useAuthSync()

  // Publish --panel-offset so the fixed transport bar clears the docked side
  // panel (which now occupies the `panel` grid track and reflows the score).
  // A panel is docked exactly when a score exists at the xl dock breakpoint —
  // true for both the chat panel and the AI-diff panel, which share the track.
  // Single race-free writer (mirrors SessionSidebar's --sidebar-offset).
  const wideDock = useMatchMedia(mq.up('xl'))
  const hasScore = useChatStore((s) => Boolean(s.abc))
  const dockedPanelPresent = wideDock && hasScore
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--panel-offset', dockedPanelPresent ? 'var(--panel-w)' : '0px')
    return () => root.style.setProperty('--panel-offset', '0px')
  }, [dockedPanelPresent])

  return (
    <div className={styles.shell}>
      <SessionSidebar />
      <AppHeader />
      <Hero />
      <ChatHistoryPanel />
      {/* Docked AI-diff panel — a direct shell child so it can occupy the
          `panel` grid track (push) at xl, like the chat panel. */}
      <GhostPreviewPanel />
      <DebugPanel />
      <AuthModal />
    </div>
  )
}
