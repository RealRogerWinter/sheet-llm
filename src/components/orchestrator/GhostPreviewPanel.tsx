'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore, type PendingProposal } from '@/lib/chat/state'
import { mq } from '@/lib/ui/breakpoints'
import { useMatchMedia } from '@/lib/ui/useMatchMedia'
import { findEventLocationById } from '@/lib/music/scoreAccessors'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import type {
  ConfirmReplacementRequest,
  ConfirmReplacementResponse,
} from '@/lib/shared/types'
import styles from './GhostPreviewPanel.module.css'

interface DiffRow {
  eventId: string
  /** 1-indexed measure for human display. */
  bar: number
  /** 1-indexed beat for human display (position within the measure
   *  by event ordinal — not a music-theoretic beat number). */
  beat: number
  /** Brief textual descriptor of the event in the AFTER score. */
  afterLabel: string
  /** Same for the BEFORE score; "(new)" when the event was inserted. */
  beforeLabel: string
}

/**
 * M24-PR-4 — AI ghost preview docked diff panel (>=5 affected events).
 *
 * Renders when `pendingProposal.presentation === 'diff-panel'`. The
 * score already shows the candidate's abc (Hero swap, M24-PR-3b) with
 * the affected noteheads recolored warm-amber by `GhostPreviewAmber`
 * (shared across both presentations); this component overlays a 360px
 * right-docked panel showing the per-event diff and an Accept-all /
 * Reject pair.
 *
 * Why a docked list rather than the inline toolbar: at >=5 affected
 * events the user wants a structured "what's changing" list they can
 * scan, alongside the on-score amber recolor that shows *where* the
 * changes land. The panel mirrors the M3.5-PR-4 ReplacementConfirmModal
 * pattern (text-based diff, not abcjs render — sizing + perf at the v1
 * stage).
 *
 * Hides the chat history panel when active (one right-docked panel
 * at a time). Accept/Reject reuse `/api/chat/confirm-replacement`
 * just like GhostPreviewOverlay — same CAS semantics.
 *
 * Keyboard: Enter accept-all, Esc reject. Same textarea-focus guard
 * as the inline overlay to avoid stealing the prompt-bar's Enter.
 */
export function GhostPreviewPanel() {
  const proposal = useChatStore((s) => s.pendingProposal)
  const acceptPendingProposal = useChatStore((s) => s.acceptPendingProposal)
  const rejectPendingProposal = useChatStore((s) => s.rejectPendingProposal)
  const panelOpen = useChatStore((s) => s.panelOpen)
  const setPanelOpen = useChatStore((s) => s.setPanelOpen)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [lastSeenId, setLastSeenId] = useState<string | undefined>(
    proposal?.candidateVersionId,
  )
  if (proposal?.candidateVersionId !== lastSeenId) {
    setLastSeenId(proposal?.candidateVersionId)
    setSubmitting(false)
    setError(undefined)
  }

  const diffRows = useDiffRows(proposal)
  const active = !!proposal && proposal.presentation === 'diff-panel'

  // Close the chat history panel when the diff panel takes the right
  // dock. Restores the chat panel state on dismount? No — once the
  // user acted on the proposal, leaving the chat panel closed matches
  // their original "I'm looking at the score" intent.
  useEffect(() => {
    if (active && panelOpen) {
      setPanelOpen(false)
    }
    // setPanelOpen is a Zustand setter (stable); intentionally not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, panelOpen])

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

  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent) {
      if (submitting) return
      const a = document.activeElement as HTMLElement | null
      if (
        a &&
        (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)
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
  }, [active, submitting, onDecision])

  // At xl the panel PUSHES the score (reflows beside it, not an overlay), so it
  // isn't truly modal — the score stays interactive. Only mark it modal in the
  // fixed-overlay variant below xl.
  const pushed = useMatchMedia(mq.up('xl'))

  if (!active || !proposal) return null

  return (
    <aside
      className={styles.panel}
      role={pushed ? 'complementary' : 'dialog'}
      aria-modal={pushed ? undefined : true}
      aria-label={`AI proposal — ${diffRows.length} changes`}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>AI proposal</h2>
        <div className={styles.subtitle}>
          {diffRows.length} {diffRows.length === 1 ? 'change' : 'changes'}
        </div>
      </header>
      {proposal.introText && <p className={styles.intro}>{proposal.introText}</p>}
      <ul className={styles.diffList}>
        {diffRows.map((row) => (
          <li key={row.eventId} className={styles.diffRow}>
            <div className={styles.diffLoc}>
              bar {row.bar}, beat {row.beat}
            </div>
            <div className={styles.diffPair}>
              <span className={styles.before}>{row.beforeLabel}</span>
              <span className={styles.arrow}>→</span>
              <span className={styles.after}>{row.afterLabel}</span>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      <footer className={styles.footer}>
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
          aria-label="Accept all (Enter)"
        >
          Accept all <kbd className={styles.kbd}>Enter</kbd>
        </button>
      </footer>
    </aside>
  )
}

/**
 * Build the per-event diff rows. Resolves each affected event id to a
 * (measure, event) position in the AFTER score, then looks up the
 * BEFORE event at the SAME index for the pairwise label.
 *
 * **Known v1 limitation: insertion in the middle of a measure shows
 * shifted pairings.** If the LLM inserts an event at index N, every
 * AFTER event from index N onward is reported as affected by
 * computeAffectedEventIds (the canon-form per-index comparison sees
 * the shift). The panel here pairs each by index, so the rows read
 * as "old[N] → new[N]" for each shifted position rather than
 * "(new) → inserted". The diff is positionally correct but doesn't
 * convey the structural insertion. Acceptable for v1 — fixing
 * requires Myers-style LCS pairing across measures, deferred.
 *
 * Why not id-match instead: canonEvent intentionally does NOT include
 * event ids (so a measure re-emitted with new uuids but identical
 * content classes as retained). The LLM is therefore not expected to
 * preserve event ids across edits, which would break id-pairing more
 * often than the index-pairing's failure mode.
 *
 * proposal is a stable identity from the store, so this memo
 * recomputes only when a new proposal is published.
 */
function useDiffRows(proposal: PendingProposal | undefined): DiffRow[] {
  return useMemo(() => {
    if (!proposal) return []
    const rows: DiffRow[] = []
    for (const id of proposal.affectedEventIds) {
      const loc = findEventLocationById(proposal.candidateScore, id)
      if (!loc) continue
      const afterMeasure = proposal.candidateScore.measures[loc.measureIdx]
      const afterEvent = afterMeasure?.events[loc.eventIdx]
      if (!afterEvent) continue
      const beforeMeasure = proposal.beforeScore.measures[loc.measureIdx]
      const beforeEvent = beforeMeasure?.events[loc.eventIdx]
      rows.push({
        eventId: id,
        bar: loc.measureIdx + 1,
        beat: loc.eventIdx + 1,
        afterLabel: labelEvent(afterEvent),
        beforeLabel: beforeEvent ? labelEvent(beforeEvent) : '(new)',
      })
    }
    return rows
  }, [proposal])
}

/** Compact textual descriptor for a single event in the diff list. */
function labelEvent(event: import('@/lib/music/types').Event): string {
  if (event.kind === 'rest' || event.pitches.every((p) => p.step === 'rest')) {
    return `rest (${event.duration})`
  }
  const pitches = event.pitches
    .filter((p) => p.step !== 'rest')
    .map((p) => `${p.step}${p.octave}`)
    .join('+')
  if (pitches.length === 0) return `(unknown) (${event.duration})`
  return `${pitches} (${event.duration})`
}
