'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'

export type PromptPhase = 'idle' | 'sending' | 'composing' | 'arriving' | 'done'

/**
 * Reveal-complete → "done" hold before the button crosses back to
 * "Send". An 80ms breath so the user perceives the settle instead of an
 * instant snap. Driven by a setTimeout that's cleared on any phase
 * change so a new submission preempts a lingering "done" beat.
 */
const DONE_HOLD_MS = 80

/**
 * Derives a five-state phase from store fields. The split exists so the
 * PromptBar (and any future composing-aware UI) can distinguish:
 *  - 'sending'   — request just dispatched, before the composing visual
 *                  is meaningful (transient; visually folds into composing).
 *  - 'composing' — network in-flight, score area should show the
 *                  ComposingStaff loops.
 *  - 'arriving'  — response arrived, per-note reveal is in flight; input
 *                  is re-enabled (pending cleared) but the button keeps
 *                  pulsing so the wait-state reads as continuous.
 *  - 'done'      — reveal just completed, short crossfade back to 'Send'.
 *  - 'idle'      — nothing happening.
 */
export function usePromptPhase(): PromptPhase {
  const pending = useChatStore((s) => s.pending)
  const revealStartedAt = useChatStore((s) => s.revealStartedAt)
  const revealEpoch = useChatStore((s) => s.revealEpoch)

  const prevRevealEpochRef = useRef(revealEpoch)
  const [donePulse, setDonePulse] = useState(false)

  useEffect(() => {
    if (revealEpoch !== prevRevealEpochRef.current) {
      prevRevealEpochRef.current = revealEpoch
      setDonePulse(true)
      const id = window.setTimeout(() => setDonePulse(false), DONE_HOLD_MS)
      return () => window.clearTimeout(id)
    }
  }, [revealEpoch])

  if (pending) return 'composing'
  if (revealStartedAt !== null) return 'arriving'
  if (donePulse) return 'done'
  return 'idle'
}
