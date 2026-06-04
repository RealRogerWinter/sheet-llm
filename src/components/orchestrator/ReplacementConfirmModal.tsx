'use client'

import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import type {
  ConfirmReplacementRequest,
  ConfirmReplacementResponse,
} from '@/lib/shared/types'
import styles from './ReplacementConfirmModal.module.css'

type Decision = ConfirmReplacementRequest['decision']

/**
 * M3.5-PR-4 — replacement-as-confirmation gate modal.
 *
 * Renders when `useChatStore.pendingConfirmation` is set (i.e. the
 * latest /api/chat response carried `requiresConfirmation: true`).
 *
 * Shows:
 *   - the reasons the orchestrator flagged this as a wholesale
 *     replacement (e.g. "only 0 of 4 measures retained", "key C → Am")
 *   - a side-by-side preview of the current score vs. the AI proposal,
 *     rendered as ABC text (cheap, no abcjs render needed at v1; the
 *     existing ScorePanel renders the head once we apply)
 *   - three actions:
 *       Replace anyway                         → POST decision=accept
 *       Keep my version                        → POST decision=reject
 *       Replace anyway and don't ask again      → POST decision=
 *                                                 dont_ask_again_this_session
 *
 * On any non-reject success the editor swaps to the candidate score
 * and the modal closes; on reject the editor stays put.
 *
 * Reuses existing `scoreToAbc` for the preview text (instead of
 * pulling abcjs into the modal directly). v1 limitation: the diff is
 * text-based, not visual notation. A follow-up PR can swap in a
 * proper ScorePanel render once we confirm the modal sizing works.
 */
export function ReplacementConfirmModal() {
  const pending = useChatStore((s) => s.pendingConfirmation)
  const clearPending = useChatStore((s) => s.clearPendingConfirmation)
  const resolveRequest = useChatStore((s) => s.resolveRequest)
  const setCurrentHeadVersionId = useChatStore((s) => s.setCurrentHeadVersionId)
  const appendTurns = useChatStore((s) => s.appendTurns)
  // Tracking the last seen candidate id lets us reset submitting/error
  // when the modal opens fresh (a new candidate replaces a stale one).
  // We do this with a render-time guard (the React-recommended pattern
  // for "reset state when prop changes" — see https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes)
  // so we don't trigger a setState-in-effect cascading render.
  const [lastSeenId, setLastSeenId] = useState<string | undefined>(pending?.candidateVersionId)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  if (pending?.candidateVersionId !== lastSeenId) {
    setLastSeenId(pending?.candidateVersionId)
    setSubmitting(false)
    setError(undefined)
  }

  const onDecision = useCallback(
    async (decision: Decision) => {
      if (!pending || submitting) return
      setSubmitting(true)
      setError(undefined)
      try {
        const body: ConfirmReplacementRequest = {
          chatId: pending.chatId,
          candidateVersionId: pending.candidateVersionId,
          decision,
        }
        const res = await fetch('/api/chat/confirm-replacement', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? `Request failed: ${res.status}`)
        }
        const data = (await res.json()) as ConfirmReplacementResponse

        if (decision === 'reject') {
          // Head moved to a revert row pointing at the prior head's
          // content. The editor's current score is already the prior
          // head's score, so we just need to refresh the head-version-id
          // for future edit chaining.
          setCurrentHeadVersionId(data.headVersionId)
        } else {
          // accept (or dont_ask_again): swap the editor to the candidate
          // score and append the assistant render_score turn to the
          // transcript so the chat history reflects the applied change.
          resolveRequest(pending.abc, pending.candidateScore, pending.introText)
          setCurrentHeadVersionId(data.headVersionId)
          if (pending.toolUseId) {
            appendTurns([
              {
                role: 'assistant',
                kind: 'render_score',
                introText: pending.introText,
                scoreSummary: summarizeScore(pending.candidateScore),
                toolUseId: pending.toolUseId,
              },
            ])
          }
        }
        clearPending()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed')
        setSubmitting(false)
      }
    },
    [pending, submitting, clearPending, resolveRequest, setCurrentHeadVersionId, appendTurns],
  )

  // Escape DISMISSES the modal locally — it does NOT post decision=reject.
  //
  // Posting reject writes a revert audit row + burns a DB write, and an
  // inadvertent ESC keypress shouldn't create permanent score_versions
  // rows. The orphan candidate row stays in the DB but is unreachable
  // from the head chain — that's fine; it matches the existing
  // orphan-branch pattern for undone-then-replaced edits described in
  // project_codebase_arch.md. If the user later wants to actually reject,
  // they re-trigger the gate (the next turn produces a new candidate)
  // or click "Keep my version" in the open modal.
  useEffect(() => {
    if (!pending) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault()
        clearPending()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, submitting, clearPending])

  if (!pending) return null

  let beforeAbc = ''
  let afterAbc = ''
  try {
    beforeAbc = scoreToAbc(pending.beforeScore)
  } catch {
    beforeAbc = '(unable to render current score)'
  }
  try {
    afterAbc = scoreToAbc(pending.candidateScore)
  } catch {
    afterAbc = '(unable to render AI proposal)'
  }

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="rcm-title">
      <div className={styles.modal}>
        <div className={styles.header} id="rcm-title">
          AI proposed a major change
        </div>
        <div className={styles.body}>
          <ol className={styles.reasons}>
            {pending.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
          <div className={styles.diff}>
            <div className={styles.diffCol}>
              <div className={styles.diffLabel}>Your current score</div>
              <pre className={styles.diffScore}>{beforeAbc}</pre>
            </div>
            <div className={styles.diffCol}>
              <div className={styles.diffLabel}>AI proposal</div>
              <pre className={styles.diffScore}>{afterAbc}</pre>
            </div>
          </div>
          {error && (
            <div role="alert" style={{ color: 'var(--text-error, #c00)', fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>
        <div className={styles.footer}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={() => void onDecision('reject')}
            disabled={submitting}
            aria-label="Keep my version (reject the AI proposal)"
          >
            Keep my version
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => void onDecision('accept')}
            disabled={submitting}
            aria-label="Replace anyway (apply the AI proposal)"
          >
            Replace anyway
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => void onDecision('dont_ask_again_this_session')}
            disabled={submitting}
            aria-label="Replace anyway and don't ask again this session"
          >
            Replace anyway and don&apos;t ask again this session
          </button>
        </div>
      </div>
    </div>
  )
}
