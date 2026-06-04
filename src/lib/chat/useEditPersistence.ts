'use client'

import { useEffect, useRef } from 'react'
import { useChatStore } from '@/lib/chat/state'
import {
  enqueue,
  flushBeacon,
  setAdapter,
} from '@/lib/chat/persistenceQueue'
import type { Score } from '@/lib/music/types'

/**
 * Watches `editedScore`, enqueues each coalesced change for the
 * persistence queue, and installs the window-level listeners that
 * drive the unload/visibility flush triggers.
 *
 * Was: a fire-and-forget POST per edit. Now: enqueues into
 * `persistenceQueue` which batches via `/api/sessions/:id/versions/
 * batch`, retries on transient failure, and `sendBeacon`s on unload.
 *
 * Gates by comparing identity against `scoreJson` (the LLM baseline).
 * When they match, the change came from `resolveRequest` (a fresh
 * LLM/hydration response), not from a user edit — skip.
 */
export function useEditPersistence() {
  const chatId = useChatStore((s) => s.chatId)
  const editedScore = useChatStore((s) => s.editedScore)
  const scoreJson = useChatStore((s) => s.scoreJson)
  const currentHeadVersionId = useChatStore((s) => s.currentHeadVersionId)
  const setCurrentHeadVersionId = useChatStore(
    (s) => s.setCurrentHeadVersionId,
  )

  // Wire the queue to the live store on mount. The adapter's getHead
  // closure reads from the LIVE store via useChatStore.getState(),
  // not the snapshot captured at hook-render time — otherwise the
  // queue's baseParentVersionId would drift behind every successful
  // write. setHead mutates the store via the captured setter.
  useEffect(() => {
    setAdapter({
      getHead: () => useChatStore.getState().currentHeadVersionId,
      setHead: (id) => setCurrentHeadVersionId(id),
    })
  }, [setCurrentHeadVersionId])

  // Track the last-enqueued score so the same edit doesn't fire a
  // duplicate enqueue on unrelated re-renders.
  const lastEnqueuedRef = useRef<Score | undefined>(undefined)

  useEffect(() => {
    lastEnqueuedRef.current = undefined
  }, [chatId])

  useEffect(() => {
    if (!chatId || !editedScore) return
    if (editedScore === scoreJson) return
    if (lastEnqueuedRef.current === editedScore) return
    lastEnqueuedRef.current = editedScore
    // The store's keystroke coalesce is already 500ms. We pass it
    // through so the queue can collapse jobs that fall inside the
    // same 2s idle window.
    enqueue({
      chatId,
      score: editedScore,
      source: 'edit',
      coalesceKey: 'edit', // placeholder; per-key coalescing handled by store
    })
  }, [chatId, editedScore, scoreJson, currentHeadVersionId])

  // Window listeners — install once. Both visibilitychange:hidden and
  // beforeunload trigger the beacon path; sendBeacon is keepalive so
  // it survives the unload.
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'hidden') {
        flushBeacon()
      }
    }
    function onUnload() {
      flushBeacon()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
