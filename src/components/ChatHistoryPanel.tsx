'use client'

import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore } from '@/lib/chat/state'
import { useSubmitPrompt } from '@/lib/chat/useSubmitPrompt'
import { usePromptHistory } from '@/lib/chat/usePromptHistory'
import { mq } from '@/lib/ui/breakpoints'
import { useMatchMedia } from '@/lib/ui/useMatchMedia'
import type { RevertRequest, RevertResponse, TranscriptTurn } from '@/lib/shared/types'
import styles from './ChatHistoryPanel.module.css'

type PanelMode = 'docked' | 'drawer' | 'sheet'

// Docked at xl (≥1280px), full-height bottom sheet below md (<768px), and a
// right-edge drawer in between. Canonical breakpoints from src/lib/ui.
const DOCK_BREAKPOINT = mq.up('xl')
const SHEET_BREAKPOINT = mq.down('md')

/**
 * Resolve the human-readable failure message for an errored assistant
 * text turn. Client-side failures (`failStreamingTurn`) attach a full
 * `errorText`; server-hydrated turns carry only an `errorCode`, which we
 * map to a friendly sentence here.
 */
function erroredTurnMessage(
  turn: Extract<TranscriptTurn, { role: 'assistant'; kind: 'text' }>,
): string {
  if (turn.errorText) return turn.errorText
  switch (turn.errorCode) {
    case 'stale_partial':
      return 'This response was interrupted and never finished.'
    case 'upstream_error':
      return 'The model failed while generating this response.'
    case 'client_abort':
      return 'This response was cancelled.'
    default:
      return 'This response did not complete.'
  }
}

function usePanelMode(): PanelMode {
  const wide = useMatchMedia(DOCK_BREAKPOINT)
  const narrow = useMatchMedia(SHEET_BREAKPOINT)
  if (wide) return 'docked'
  if (narrow) return 'sheet'
  return 'drawer'
}

export default function ChatHistoryPanel() {
  const open = useChatStore((s) => s.panelOpen)
  const abc = useChatStore((s) => s.abc)
  const turns = useChatStore((s) => s.turns)
  const loading = useChatStore((s) => s.transcriptLoading)
  const transcriptError = useChatStore((s) => s.transcriptError)
  const chatId = useChatStore((s) => s.chatId)
  const requestError = useChatStore((s) => s.error)
  const setPanelOpen = useChatStore((s) => s.setPanelOpen)
  const retryTranscriptSync = useChatStore((s) => s.retryTranscriptSync)
  const reset = useChatStore((s) => s.reset)

  // True while the docked AI-diff panel is showing — it shares the dock track.
  const ghostDiffActive = useChatStore((s) => s.pendingProposal?.presentation === 'diff-panel')

  const mode = usePanelMode()

  // The panel is permanently visible in docked mode (>=1280px) once a
  // score exists; in the narrower drawer / sheet modes it stays an
  // opt-in overlay so a 360px panel never covers the score.
  const isDocked = mode === 'docked'

  // No score yet (the hero / landing state) → never render the panel.
  if (!abc) return null
  // The docked AI-diff panel (GhostPreviewPanel) occupies the SAME `panel`
  // grid track. When it's active, yield the dock to it so two panels don't
  // both mount into the track (the docked chat panel otherwise ignores
  // panelOpen and would overlap underneath it).
  if (isDocked && ghostDiffActive) return null
  // In the narrow modes the panel is a toggled overlay; respect panelOpen.
  // In docked mode it's permanent and ignores panelOpen.
  if (!isDocked && !open) return null

  return (
    <>
      {!isDocked && (
        <div
          className={styles.backdrop}
          onClick={() => setPanelOpen(false)}
          role="presentation"
        />
      )}
      <aside
        id="chat-history-panel"
        className={styles.panel}
        data-mode={mode}
        role={isDocked ? 'complementary' : 'dialog'}
        aria-label="Chat history"
        {...(isDocked ? {} : { 'aria-modal': true })}
      >
        <PanelHeader
          turnCount={turns.length}
          onClose={() => setPanelOpen(false)}
          onNewChat={async () => {
            const confirmed =
              turns.length === 0 || window.confirm('Clear this conversation and start fresh?')
            if (!confirmed) return
            await reset()
          }}
          mode={mode}
        />
        <div className={styles.list}>
          {loading && turns.length === 0 && <LoadingState />}
          {transcriptError && (
            <ErrorState message={transcriptError} onRetry={retryTranscriptSync} />
          )}
          {!loading && !transcriptError && turns.length === 0 && (
            <EmptyState hasChatId={Boolean(chatId)} />
          )}
          {turns.length > 0 && (
            <TranscriptList
              turns={turns}
              requestError={requestError}
              fromChatId={chatId}
            />
          )}
        </div>
        <PanelFooter />
      </aside>
    </>
  )
}

function PanelHeader({
  turnCount,
  onClose,
  onNewChat,
  mode,
}: {
  turnCount: number
  onClose: () => void
  onNewChat: () => void | Promise<void>
  mode: PanelMode
}) {
  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <span className={styles.title}>Conversation</span>
        {turnCount > 0 && (
          <span className={styles.turnCount}>
            {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
          </span>
        )}
      </div>
      <div className={styles.headerActions}>
        <button
          type="button"
          className={styles.headerAction}
          onClick={onNewChat}
          disabled={turnCount === 0}
          aria-label="Start a new conversation"
        >
          New chat
        </button>
        {/* Docked mode is permanent — no close button (you can't dismiss
         *  a sidebar that's meant to always be there). The narrow
         *  drawer / sheet overlays keep the close affordance. */}
        {mode !== 'docked' && (
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close conversation panel"
          >
            ×
          </button>
        )}
      </div>
    </header>
  )
}

function LoadingState() {
  return (
    <div className={styles.placeholder} role="status">
      <span className={styles.pulse} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>Loading conversation…</span>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.errorPanel} role="alert">
      <span>{message}</span>
      <button type="button" className={styles.retryButton} onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function EmptyState({ hasChatId }: { hasChatId: boolean }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>
        {hasChatId ? 'No turns yet' : 'Your conversation will appear here'}
      </p>
      <p className={styles.emptyBody}>
        Ask for a score in the prompt below, then refine it. Press{' '}
        <kbd className={styles.kbd}>Ctrl</kbd> + <kbd className={styles.kbd}>/</kbd> to toggle this
        panel.
      </p>
    </div>
  )
}

/**
 * The transcript list. Owns auto-scroll behaviour: scrolls to bottom on
 * new turns unless the user is already scrolled away from the bottom.
 */
function TranscriptList({
  turns,
  requestError,
  fromChatId,
}: {
  turns: TranscriptTurn[]
  requestError: string | undefined
  fromChatId: string | undefined
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    stickToBottomRef.current = distanceFromBottom < 100
  }

  // Track the trailing assistant streaming-text length so the
  // scroll-to-bottom effect also fires while text deltas grow inside
  // an existing turn (turns.length doesn't change during streaming).
  // Programmatic scrollTop assignment lands at distanceFromBottom=0 so
  // handleScroll keeps stickToBottomRef true; if the user scrolls up
  // mid-stream, the ref flips false and subsequent deltas leave the
  // viewport alone — the user's manual scroll wins.
  const trailingTurn = turns[turns.length - 1]
  const trailingStreamLen =
    trailingTurn?.role === 'assistant' && trailingTurn.kind === 'text'
      ? trailingTurn.text.length
      : 0

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns.length, trailingStreamLen])

  // Determine the index of the last assistant SCORE turn — used to mark
  // "Current" and hide the Restore action on the in-use score. Text-only
  // (converse) assistant turns don't reset the score, so they're skipped.
  let lastAssistantIdx = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role === 'assistant' && t.kind === 'render_score') {
      lastAssistantIdx = i
      break
    }
  }

  const showErrorOnTrailing =
    requestError !== undefined && trailingTurn?.role === 'user'

  return (
    <div className={styles.transcript} ref={containerRef} onScroll={handleScroll}>
      {turns.map((turn, i) => (
        <TurnView
          key={i}
          turn={turn}
          isCurrent={i === lastAssistantIdx}
          fromChatId={fromChatId}
        />
      ))}
      {showErrorOnTrailing && (
        <div className={styles.requestError} role="alert">
          {requestError}
        </div>
      )}
    </div>
  )
}

function TurnView({
  turn,
  isCurrent,
  fromChatId,
}: {
  turn: TranscriptTurn
  isCurrent: boolean
  fromChatId: string | undefined
}) {
  if (turn.role === 'user') {
    return (
      <div className={styles.turn} data-role="user">
        <div className={styles.roleLabel}>You</div>
        {turn.kind === 'refinement' && turn.hadEdit && (
          <div className={styles.editedPill}>Edited score before sending</div>
        )}
        <div className={styles.userBubble}>{turn.text}</div>
      </div>
    )
  }

  // assistant: text answer (converse) or render_score
  if (turn.kind === 'text') {
    const errored = turn.errored === true
    return (
      <div className={styles.turn} data-role="assistant">
        <div className={`${styles.roleLabel} ${errored ? styles.roleLabelErrored : ''}`}>
          {errored ? 'Generation failed' : 'sheet-llm'}
        </div>
        <div
          className={`${styles.answerBubble} ${errored ? styles.answerBubbleErrored : ''}`}
        >
          {turn.text && (
            <div className={styles.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
            </div>
          )}
          {errored && (
            <div className={styles.turnError} role="alert">
              <span className={styles.turnErrorIcon} aria-hidden="true">
                ⚠
              </span>
              <span>{erroredTurnMessage(turn)}</span>
            </div>
          )}
          {turn.streaming && (
            <span className={styles.streamingCursor} aria-hidden="true" />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.turn} data-role="assistant">
      <div className={styles.roleLabel}>sheet-llm · Score</div>
      {turn.introText && <p className={styles.intro}>{turn.introText}</p>}
      <ScoreCard
        turn={turn}
        isCurrent={isCurrent}
        fromChatId={fromChatId}
      />
    </div>
  )
}

function ScoreCard({
  turn,
  isCurrent,
  fromChatId,
}: {
  turn: Extract<TranscriptTurn, { role: 'assistant'; kind: 'render_score' }>
  isCurrent: boolean
  fromChatId: string | undefined
}) {
  const { scoreSummary, toolUseId } = turn
  return (
    <div className={`${styles.scoreCard} ${isCurrent ? styles.scoreCardCurrent : ''}`}>
      <div className={styles.scoreCardHead}>
        <span className={styles.scoreCardTitle}>{scoreSummary.title || 'Untitled score'}</span>
        {isCurrent && <span className={styles.currentBadge}>Current</span>}
      </div>
      <div className={styles.scoreCardMeta}>
        {scoreSummary.measureCount} {scoreSummary.measureCount === 1 ? 'bar' : 'bars'}
        {' · '}
        {scoreSummary.key}
        {' · '}
        {scoreSummary.meter}
        {scoreSummary.tempo_bpm !== undefined && (
          <>
            {' · '}♩ = {scoreSummary.tempo_bpm}
          </>
        )}
      </div>
      {!isCurrent && fromChatId && (
        <div className={styles.scoreCardRevertRow}>
          <RevertLink chatId={fromChatId} toolUseId={toolUseId} />
        </div>
      )}
    </div>
  )
}

/**
 * Inline "Revert" link — performs an in-place revert in the SAME chat.
 * POSTs /api/chat/revert; the server appends a synthetic assistant turn
 * carrying a copy of the chosen historical score and bumps the session
 * head. The client appends the new turn locally and swaps the editor.
 * Confirms first if there are unsaved manual edits.
 */
function RevertLink({ chatId, toolUseId }: { chatId: string; toolUseId: string }) {
  const scoreJson = useChatStore((s) => s.scoreJson)
  const historyPointer = useChatStore((s) => s.historyPointer)
  const pendingChat = useChatStore((s) => s.pending)
  const applyRevertResponse = useChatStore((s) => s.applyRevertResponse)
  const failRequest = useChatStore((s) => s.failRequest)
  const [busy, setBusy] = useState(false)

  const disabled = busy || pendingChat

  async function doRevert() {
    if (disabled) return
    const hasEdits = scoreJson !== undefined && historyPointer > 0
    if (hasEdits) {
      const ok = window.confirm(
        'Reverting to this version will discard your unsaved manual edits. Continue?',
      )
      if (!ok) return
    }
    setBusy(true)
    try {
      const body: RevertRequest = { chatId, toolUseId }
      const res = await fetch('/api/chat/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        failRequest(data.error ?? `Revert failed: ${res.status}`)
        return
      }
      const data = (await res.json()) as RevertResponse
      applyRevertResponse({
        newTurn: data.newTurn,
        scoreJson: data.scoreJson,
        abc: data.abc,
        introText: data.introText,
        headVersionId: data.headVersionId,
      })
    } catch (e) {
      failRequest(e instanceof Error ? e.message : 'Revert failed')
    } finally {
      setBusy(false)
    }
  }

  function onClick(e: MouseEvent) {
    e.preventDefault()
    void doRevert()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void doRevert()
    }
  }

  return (
    <a
      href="#"
      role="button"
      className={styles.revertLink}
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-disabled={disabled}
      aria-label="Revert to this version"
    >
      {busy ? 'Reverting…' : '↺ Revert to this version'}
    </a>
  )
}

function PanelFooter() {
  const { submit, pending } = useSubmitPrompt()
  const [value, setValue] = useState('')
  const history = usePromptHistory()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if (!text) return
    setValue('')
    history.reset()
    await submit(text)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp') {
      const prev = history.previous(value)
      if (prev !== undefined) {
        e.preventDefault()
        setValue(prev)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      const nxt = history.next()
      if (nxt !== undefined) {
        e.preventDefault()
        setValue(nxt)
      }
    }
  }

  return (
    <footer className={styles.footer}>
      <form onSubmit={onSubmit} className={styles.form}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Refine the score…"
          aria-label="Continue the conversation"
          className={styles.input}
        />
        <button
          type="submit"
          className={styles.sendButton}
          disabled={pending || !value.trim()}
          aria-label={pending ? 'Generating' : 'Send'}
        >
          {pending ? '…' : 'Send'}
        </button>
      </form>
    </footer>
  )
}
