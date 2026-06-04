'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './ResumeProposalToast.module.css'

/** Milliseconds the toast stays on screen before auto-dismissing. */
export const RESUME_TOAST_TIMEOUT_MS = 30_000

/**
 * M24-PR-5 — "Resume AI suggestion" toast.
 *
 * When a manual edit interrupts a pending AI proposal (applyEdit /
 * applyBalancedEdit / applyScore / undo / redo / resetEditsToLLM all
 * stash the prior proposal on `interruptedProposal`), this toast
 * offers the user a 30-second window to put it back.
 *
 *   Resume   → calls `resumeInterruptedProposal()` which copies the
 *              slot back to `pendingProposal`. The same server-side
 *              candidate row is reused, so accept-from-resumed
 *              promotes cleanly.
 *   Dismiss  → calls `clearInterruptedProposal()` — slot is gone.
 *   30s tick → auto-dismiss (same `clearInterruptedProposal()`).
 *
 * **V1 trade-off**: dismiss (or 30s timeout) leaves the server-side
 * candidate score_versions row as an orphan — it's no longer reachable
 * from the head chain, matching the existing
 * orphan-branch-on-undone-then-replaced pattern documented in
 * project_codebase_arch.md. Same behavior the replacement-confirm
 * modal has when Esc dismisses without posting reject. Cleanup of
 * orphan rows is a separate cron concern, not blocking for v1.
 *
 * Renders at bottom-left so it doesn't overlap GhostPreviewOverlay
 * (bottom-center) or the editor's existing UndoToast (typically
 * bottom-right). The visual treatment mirrors UndoToast: subtle, with
 * one primary action and a dismiss affordance.
 */
export function ResumeProposalToast() {
  const interrupted = useChatStore((s) => s.interruptedProposal)
  const resumeInterruptedProposal = useChatStore(
    (s) => s.resumeInterruptedProposal,
  )
  const clearInterruptedProposal = useChatStore(
    (s) => s.clearInterruptedProposal,
  )

  // Re-fire the timeout when a NEW interrupted proposal lands (the
  // candidateVersionId is the stable identity). Without this, a second
  // interruption while the toast was still up would inherit the old
  // timer's remaining time instead of getting a fresh 30s.
  const [lastSeenId, setLastSeenId] = useState<string | undefined>(
    interrupted?.candidateVersionId,
  )
  if (interrupted?.candidateVersionId !== lastSeenId) {
    setLastSeenId(interrupted?.candidateVersionId)
  }

  useEffect(() => {
    if (!interrupted) return
    const id = window.setTimeout(() => {
      clearInterruptedProposal()
    }, RESUME_TOAST_TIMEOUT_MS)
    return () => window.clearTimeout(id)
  }, [lastSeenId, interrupted, clearInterruptedProposal])

  if (!interrupted) return null

  return (
    <div
      className={styles.toast}
      role="status"
      aria-live="polite"
      aria-label="AI suggestion was paused; click resume to restore it"
    >
      <span className={styles.label}>AI suggestion paused</span>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={resumeInterruptedProposal}
        >
          Resume
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={clearInterruptedProposal}
          aria-label="Dismiss resume-AI suggestion"
        >
          ×
        </button>
      </div>
    </div>
  )
}
