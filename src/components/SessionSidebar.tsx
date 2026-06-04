'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useChatStore } from '@/lib/chat/state'
import { useAuthStore } from '@/lib/auth/authStore'
import { mq as bp } from '@/lib/ui/breakpoints'
import type {
  SessionListResponse,
  SessionSummary,
} from '@/lib/shared/types'
import styles from './SessionSidebar.module.css'

/**
 * Left-rail sidebar listing every session the current user owns.
 *
 * Self-contained: fetches /api/sessions on mount and refreshes when the
 * chatId changes (covers the "user submitted a new prompt → session
 * created on the server" path without a global event bus). Click a row
 * to switch sessions — the existing useTranscriptSync hook re-fetches
 * the transcript when chatId changes.
 *
 * Row interactions:
 *   - click            → switch to this session
 *   - double-click title → enter rename mode (input, Enter commits,
 *                          Escape cancels, blur commits)
 *   - hover            → reveals the `×` delete button (window.confirm)
 *
 * All mutations are optimistic with a refetch-on-error rollback —
 * cheaper than per-row undo bookkeeping and the refetch was happening
 * on chatId-change anyway.
 */
export default function SessionSidebar() {
  const chatId = useChatStore((s) => s.chatId)
  const setChatId = useChatStore((s) => s.setChatId)
  const clearTurns = useChatStore((s) => s.clearTurns)
  const cancelStreamingForSwitch = useChatStore((s) => s.cancelStreamingForSwitch)
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const setSidebarOpen = useChatStore((s) => s.setSidebarOpen)
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useChatStore((s) => s.setSidebarCollapsed)
  // Sessions are user-scoped, so the list must follow auth state: logging in
  // should surface the account's saved sessions and logging out should clear
  // them — both without a manual page reload.
  const authStatus = useAuthStore((s) => s.status)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [editingId, setEditingId] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const res = await fetch('/api/sessions', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as SessionListResponse
      setSessions(body.sessions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchSessions toggles loading/error state; this is a real fetch-on-mount/chatId-/auth-change sync, not derivable from render
    void fetchSessions()
  }, [chatId, authStatus, fetchSessions])

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') void fetchSessions()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchSessions])

  const handleSelect = useCallback(
    (id: string) => {
      if (id === chatId) return
      if (editingId) return // don't switch while editing
      // Abandon any in-flight streamed generation for the OLD session: drop
      // its pending/composing flags now so the overlay doesn't carry over,
      // and the stream consumer (guarded by its originating chatId) stops
      // writing once it notices the switch.
      cancelStreamingForSwitch()
      // Clear turns so useTranscriptSync's "already has turns → skip"
      // guard doesn't suppress the re-fetch for the newly-selected
      // session.
      clearTurns()
      setChatId(id)
      // Close the drawer on mobile after a successful switch — the
      // backdrop click handler would also do it, but doing it on the
      // row click is more direct.
      setSidebarOpen(false)
    },
    [chatId, cancelStreamingForSwitch, clearTurns, editingId, setChatId, setSidebarOpen],
  )

  // Close-on-Escape (a11y staple). Closes whichever surface is visible:
  // the mobile drawer if open, or the desktop sidebar if expanded.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (sidebarOpen) {
        setSidebarOpen(false)
        return
      }
      if (typeof window !== 'undefined' && window.matchMedia(bp.up('lg')).matches) {
        if (!sidebarCollapsed) setSidebarCollapsed(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sidebarOpen, setSidebarOpen, sidebarCollapsed, setSidebarCollapsed])

  // Publish --sidebar-offset so fixed-position chrome (transport bar)
  // can shift to clear the docked sidebar on desktop. CSS-only would
  // need :has() with a media-query, awkward; an imperative writer is
  // simpler and matches the existing transitions.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const root = document.documentElement
    const apply = () => {
      const isDesktop = window.matchMedia(bp.up('lg')).matches
      const docked = isDesktop && !sidebarCollapsed
      root.style.setProperty('--sidebar-offset', docked ? '280px' : '0px')
    }
    apply()
    const mq = window.matchMedia(bp.up('lg'))
    const onMq = () => apply()
    if (mq.addEventListener) mq.addEventListener('change', onMq)
    else mq.addListener(onMq)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onMq)
      else mq.removeListener(onMq)
      root.style.setProperty('--sidebar-offset', '0px')
    }
  }, [sidebarCollapsed])

  const handleRename = useCallback(
    async (id: string, nextTitle: string) => {
      const normalized = nextTitle.trim()
      // Optimistic update — splice the new title in place.
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, title: normalized.length === 0 ? null : normalized } : s,
        ),
      )
      try {
        const res = await fetch(`/api/sessions/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ title: normalized.length === 0 ? null : normalized }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        // Rollback by refetching authoritative state.
        void fetchSessions()
      }
    },
    [fetchSessions],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      if (typeof window !== 'undefined' && !window.confirm('Delete this session? This cannot be undone.')) {
        return
      }
      // Optimistic remove.
      setSessions((prev) => prev.filter((s) => s.id !== id))
      // If the deleted row was active, drop the editor too — otherwise
      // the user stares at a score pinned to a session that no longer
      // exists in the sidebar.
      if (id === chatId) {
        clearTurns()
        setChatId(undefined)
      }
      try {
        const res = await fetch(`/api/sessions/${id}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        })
        if (!res.ok && res.status !== 204) {
          throw new Error(`HTTP ${res.status}`)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        void fetchSessions()
      }
    },
    [chatId, clearTurns, fetchSessions, setChatId],
  )

  return (
    <>
      {sidebarOpen && (
        <div
          className={styles.backdrop}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        id="session-sidebar"
        className={styles.sidebar}
        aria-label="Sessions"
        data-open={sidebarOpen}
        data-collapsed={sidebarCollapsed}
      >
      <header className={styles.header}>
        <h2 className={styles.heading}>Sessions</h2>
      </header>
      {error && (
        <div className={styles.error} role="alert">
          Couldn’t reach the server: {error}{' '}
          <button
            type="button"
            className={styles.retry}
            onClick={() => {
              setError(undefined)
              void fetchSessions()
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading && sessions.length === 0 && (
        <div className={styles.loading}>
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </div>
      )}
      {!loading && sessions.length === 0 && !error && (
        <div className={styles.empty}>
          No saved scores yet — your conversations will appear here.
        </div>
      )}
        {sessions.length > 0 && (
        <ul className={styles.list}>
          {sessions.map((s) => (
            <li key={s.id} className={styles.rowWrapper}>
              <button
                type="button"
                className={
                  s.id === chatId
                    ? `${styles.row} ${styles.rowActive}`
                    : styles.row
                }
                onClick={() => handleSelect(s.id)}
              >
                {editingId === s.id ? (
                  <RenameInput
                    initial={s.title ?? ''}
                    onCommit={(next) => {
                      setEditingId(null)
                      if (next !== (s.title ?? '')) {
                        void handleRename(s.id, next)
                      }
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span
                    className={styles.rowTitle}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditingId(s.id)
                    }}
                    title="Double-click to rename"
                  >
                    {titleFor(s)}
                  </span>
                )}
                <span className={styles.rowMeta}>{formatRelative(s.lastMessageAt)}</span>
                {s.preview && editingId !== s.id && (
                  <span className={styles.rowPreview}>{s.preview}</span>
                )}
              </button>
              <button
                type="button"
                className={styles.rowDelete}
                aria-label={`Delete session ${titleFor(s)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleDelete(s.id)
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      </aside>
    </>
  )
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState(initial)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <input
      ref={ref}
      type="text"
      className={styles.renameInput}
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}

function titleFor(s: SessionSummary): string {
  if (s.title && s.title.trim().length > 0) return s.title
  if (s.preview && s.preview.length > 0) {
    return s.preview.length > 50 ? s.preview.slice(0, 50) + '…' : s.preview
  }
  return 'Untitled'
}

function formatRelative(unixSeconds: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleDateString()
}
