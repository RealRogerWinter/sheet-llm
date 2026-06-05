'use client'

import { useChatStore } from '@/lib/chat/state'
import { useUsageStore } from '@/lib/usage/usageStore'
import styles from './LastConfirmationLabel.module.css'

/**
 * Shows the assistant's confirmation for the most recent score-producing
 * turn — either the model's own pre-tool-use narration or the server's
 * canned fallback (see `summarizeAction`). Lives directly beneath the
 * score (sibling to `LastPromptLabel`) and shares its lifetime: cleared
 * on `beginRequest`, set on `resolveRequest`, restored on session
 * hydration (`seedHistoryFromServer` / `resolveRequest` via
 * `useTranscriptSync`).
 *
 * Renders nothing when no score is loaded or no confirmation is set,
 * so first-load (and converse-only sessions) stay empty.
 */
export default function LastConfirmationLabel() {
  const introText = useChatStore((s) => s.introText)
  const abc = useChatStore((s) => s.abc)
  const daily = useUsageStore((s) => s.snapshot?.daily ?? null)
  if (!introText || !abc) return null
  // When the hosted daily-quota layer is on, tack the live remaining free-use
  // count onto the confirmation line (e.g. "Composed … — You have 3 free daily
  // uses left"). Hidden on self-host / Pro, where `daily` is null.
  const label =
    daily != null
      ? `${introText} — You have ${daily.remaining} free daily ${daily.remaining === 1 ? 'use' : 'uses'} left`
      : introText
  return <p className={styles.label}>{label}</p>
}
