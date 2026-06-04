'use client'

import AppHeader from './AppHeader'
import Hero from './Hero'
import DebugPanel from './DebugPanel'
import ChatHistoryPanel from './ChatHistoryPanel'
import SessionSidebar from './SessionSidebar'
import AuthModal from './auth/AuthModal'
import { GhostPreviewPanel } from './orchestrator/GhostPreviewPanel'
import styles from './AppShell.module.css'
import { useChatIdSession, useFollowPlaybackSync, useReduceMotionSync } from '@/lib/chat/state'
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
