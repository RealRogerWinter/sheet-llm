'use client'

import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import type {
  ConfirmReplacementRequest,
  ConfirmReplacementResponse,
} from '@/lib/shared/types'
import styles from './GhostPreviewOverlay.module.css'

/**
 * M24-PR-3c — AI ghost preview overlay (inline presentation).
 *
 * Renders when `pendingProposal.presentation === 'inline'`. The score
 * already shows the candidate's abc (Hero swap, M24-PR-3b) and the
 * affected noteheads are recolored warm-amber by `GhostPreviewAmber`
 * (mounted in Hero, shared across both presentations). This component
 * layers the inline chrome on top:
 *
 *   1. A floating toolbar with Accept (Enter) / Reject (Esc) buttons.
 *
 *   2. A capture-phase keyboard handler so Enter/Esc are intercepted
 *      before the editor's own listeners (e.g., note-insert popovers).
 *
 * Accept and reject both POST to `/api/chat/confirm-replacement` —
 * reused from M3.5-PR-4 because the endpoint's accept/reject CAS
 * semantics are exactly what ghost preview needs. On accept the
 * client swaps the score (via acceptPendingProposal), updates
 * currentHeadVersionId, and appends an assistant `render_score`
 * transcript turn so the chat history reflects the applied change.
 * Reject leaves the score untouched and clears the slot.
 *
 * Diff-panel proposals (>=5 affected events) are rendered by
 * `GhostPreviewPanel` in M24-PR-4 — this component early-returns on
 * the diff-panel branch. The amber recolor itself is presentation-
 * agnostic and lives in `GhostPreviewAmber`.
 */
export function GhostPreviewOverlay() {
  const proposal = useChatStore((s) => s.pendingProposal)
  const acceptPendingProposal = useChatStore((s) => s.acceptPendingProposal)
  const rejectPendingProposal = useChatStore((s) => s.rejectPendingProposal)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // Reset transient state when the slot's identity changes (a new
  // proposal replaces the prior one).
  const [lastSeenId, setLastSeenId] = useState<string | undefined>(
    proposal?.candidateVersionId,
  )
  if (proposal?.candidateVersionId !== lastSeenId) {
    setLastSeenId(proposal?.candidateVersionId)
    setSubmitting(false)
    setError(undefined)
  }

  const onDecision = useCallback(
    async (decision: 'accept' | 'reject') => {
      if (!proposal || submitting) return
      setSubmitting(true)
      setError(undefined)
      try {
        const body: ConfirmReplacementRequest = {
          chatId: proposal.chatId,
          candidateVersionId: proposal.candidateVersionId,
          decision,
        }
        const res = await fetch('/api/chat/confirm-replacement', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(errBody.error ?? `Request failed: ${res.status}`)
        }
        const data = (await res.json()) as ConfirmReplacementResponse
        const store = useChatStore.getState()
        if (decision === 'accept') {
          // Swap the editor to the candidate score + reset history.
          // acceptPendingProposal already bumps epoch + clears the slot.
          acceptPendingProposal()
          store.setCurrentHeadVersionId(data.headVersionId)
          if (proposal.toolUseId) {
            store.appendTurns([
              {
                role: 'assistant',
                kind: 'render_score',
                introText: proposal.introText,
                scoreSummary: summarizeScore(proposal.candidateScore),
                toolUseId: proposal.toolUseId,
              },
            ])
          }
        } else {
          // Reject: server wrote a revert row pointing at the prior
          // head; clear the slot + advance the local head pointer so
          // the next edit POST chains against the right CAS link.
          rejectPendingProposal()
          store.setCurrentHeadVersionId(data.headVersionId)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed')
        setSubmitting(false)
      }
    },
    [proposal, submitting, acceptPendingProposal, rejectPendingProposal],
  )

  // Capture-phase keyboard. Enter accepts, Esc rejects. Capture-phase
  // so we beat the editor's own listeners (e.g., the click-to-place
  // popover's Enter handler) — the user committed to a proposal review
  // and shouldn't see other UI react to the keypress.
  //
  // Guard: skip when an editable element has focus. Without this, an
  // Enter keypress while typing in the prompt bar's textarea would
  // accept the proposal instead of submitting the message — which
  // is the kind of silent-action violation we want to avoid.
  useEffect(() => {
    if (!proposal || proposal.presentation !== 'inline') return
    function onKey(e: KeyboardEvent) {
      if (submitting) return
      const active = document.activeElement as HTMLElement | null
      if (
        active &&
        (active.tagName === 'TEXTAREA' ||
          active.tagName === 'INPUT' ||
          active.isContentEditable)
      ) {
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void onDecision('accept')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void onDecision('reject')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [proposal, submitting, onDecision])

  if (!proposal) return null
  if (proposal.presentation !== 'inline') return null

  return (
    <div
      className={styles.toolbar}
      role="dialog"
      aria-modal="true"
      aria-label="AI proposal — accept or reject"
    >
      <span className={styles.label}>
        AI proposal
        {proposal.introText ? <>: <span className={styles.intro}>{proposal.introText}</span></> : null}
      </span>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={() => void onDecision('reject')}
          disabled={submitting}
          aria-label="Reject AI proposal (Esc)"
        >
          Reject <kbd className={styles.kbd}>Esc</kbd>
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => void onDecision('accept')}
          disabled={submitting}
          aria-label="Accept AI proposal (Enter)"
        >
          Accept <kbd className={styles.kbd}>Enter</kbd>
        </button>
      </div>
      {error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </div>
  )
}
