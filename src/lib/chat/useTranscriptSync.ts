'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/chat/state'
import type { TranscriptResponse } from '@/lib/shared/types'

/**
 * Keeps `useChatStore.turns` in sync with the server transcript for the
 * current chatId. Fires only when there's a chatId AND the local turns
 * are empty (i.e. on page refresh restoring a sessionStorage chatId, or
 * after a reset). Does NOT re-fetch on every chatId change — that
 * would clobber the optimistic appends from `useSubmitPrompt`.
 *
 * 404 → chatId was server-side-evicted (process restart in dev); clear
 * the local id so the next prompt starts a fresh chat. Matches the
 * existing 410 reset path in the POST flow.
 *
 * Network failure → preserve chatId, surface a retry chip. The
 * `retryTranscriptSync` action bumps `transcriptRetryNonce` to refire
 * this effect.
 */
export function useTranscriptSync() {
  const chatId = useChatStore((s) => s.chatId)
  const turnsLen = useChatStore((s) => s.turns.length)
  const retryNonce = useChatStore((s) => s.transcriptRetryNonce)
  const setTurns = useChatStore((s) => s.setTurns)
  const clearTurns = useChatStore((s) => s.clearTurns)
  const setChatId = useChatStore((s) => s.setChatId)
  const setLoading = useChatStore((s) => s.setTranscriptLoading)
  const setError = useChatStore((s) => s.setTranscriptError)
  const resolveRequest = useChatStore((s) => s.resolveRequest)
  const scoreJson = useChatStore((s) => s.scoreJson)

  useEffect(() => {
    if (!chatId) {
      // Don't auto-wipe turns when chatId becomes undefined. The two
      // places that legitimately need turns cleared — `reset()` (New
      // Score) and the 404/410 branch of the in-effect fetch below —
      // do so explicitly. The other path that nulls chatId is
      // `failRequest({ resetChatId: true })` for an expired session;
      // there we want the user's just-typed prompt to STAY visible so
      // they can see what they sent and retry. Wiping it here would
      // make a failed follow-up edit appear to vanish without trace.
      return
    }
    // Don't fetch when we already have turns AND a score loaded — they
    // came from optimistic appends + an in-progress edit, and a fetch
    // would clobber both. When the user clicks into a session via the
    // sidebar there are no turns yet (sidebar calls clearTurns first),
    // so we DO fetch and rehydrate. The score-loaded check covers the
    // rare "turns wiped but editor still active" path.
    if (turnsLen > 0 && scoreJson !== undefined) return

    let cancelled = false
    setLoading(true)
    setError(undefined)
    fetch(`/api/chat?chatId=${encodeURIComponent(chatId)}`)
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404 || res.status === 410) {
          setChatId(undefined)
          clearTurns()
          return
        }
        if (!res.ok) {
          setError(`Could not load chat history (${res.status})`)
          return
        }
        const data = (await res.json()) as TranscriptResponse
        setTurns(data.turns)
        // Restore the editor to the session's head score when present.
        // resolveRequest seeds editedScore + history + bumps epoch so the
        // ScoreStage crossfades just as if an LLM turn had landed.
        if (data.currentScore && data.currentAbc) {
          // Prefer the persisted parent chain when present so Ctrl+Z
          // survives reload. seedHistoryFromServer mirrors what
          // resolveRequest does for a single score but with the whole
          // chain seeded into history[].
          if (data.versions && data.versions.length > 0) {
            const scoreChain = data.versions.map((v) => v.scoreJson)
            useChatStore.getState().seedHistoryFromServer(
              scoreChain,
              scoreChain.length - 1,
              data.currentAbc,
              data.currentIntroText,
            )
          } else {
            resolveRequest(data.currentAbc, data.currentScore, data.currentIntroText)
          }
        }
        // Server-side head pointer — needed by useEditPersistence as
        // the parentVersionId for the next edit POST. Set even when
        // there's no current score (an empty session can still receive
        // its first edit POST with parentVersionId = null).
        useChatStore.getState().setCurrentHeadVersionId(data.headVersionId)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Network error loading history')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [
    chatId,
    turnsLen,
    scoreJson,
    retryNonce,
    setTurns,
    clearTurns,
    setChatId,
    setLoading,
    setError,
    resolveRequest,
  ])
}
