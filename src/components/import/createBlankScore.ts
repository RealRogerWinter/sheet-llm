'use client'

import { useChatStore } from '@/lib/chat/state'
import { resetSession } from '@/lib/chat/resetSession'
import type { ImportResponse } from '@/lib/shared/types'

/**
 * Seed a fresh editable session with an empty score. Bypasses the
 * ImportModal: POSTs to /api/import with `format:'blank'`, the server
 * mints a chatId + writes a synthetic assistant `render_score` block
 * (mirroring the import flow), and the response is lifted into the
 * chat store via `resolveImport`. The user lands in the editor with
 * one empty measure pre-selected.
 *
 * On error, returns `{ ok: false, error }` so the caller can surface
 * a message. Never throws.
 */
export async function createBlankScore(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  // If there's an existing session, fire-and-forget its server-side
  // soft-delete so the sidebar doesn't accumulate empty drafts. We
  // don't await it — if it fails, the local state is already moving
  // on to a fresh session.
  const priorChatId = useChatStore.getState().chatId
  if (priorChatId) {
    void resetSession(priorChatId).catch(() => {
      /* fire-and-forget; not blocking the new-session creation */
    })
  }

  let res: Response
  try {
    res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'blank' }),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return { ok: false, error: data.error ?? `Failed to create blank score (HTTP ${res.status})` }
  }

  const data = (await res.json()) as ImportResponse
  useChatStore.getState().resolveImport({
    chatId: data.chatId,
    abc: data.abc,
    scoreJson: data.scoreJson!,
    introText: data.introText,
    importFormat: data.importFormat,
    filename: data.filename,
  })
  // Pre-select the empty rest so the very first keystroke (A-G, 1-8)
  // operates on the right target via the existing useStaffInteractions
  // paths.
  useChatStore.getState().select({ measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
  return { ok: true }
}
