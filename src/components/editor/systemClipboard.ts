'use client'

import type { ClipboardEntry } from '@/lib/chat/state'
import { clipboardEntryFromJSON, clipboardEntryToJSON } from '@/lib/chat/clipboard'

/**
 * System-clipboard mirror (D3) — bridges the in-memory `clipboard` store
 * slot to the OS clipboard via the async Clipboard API so a copy in one
 * tab/session can paste in another. The in-memory slot stays CANONICAL for
 * intra-app paste (instant + lossless); this is a best-effort sidecar.
 *
 * Every entry point is fully guarded + swallows failures: the Clipboard API
 * is absent in jsdom and rejects without focus / permission / a secure
 * context, none of which should ever surface as an editor error.
 */

/** The Clipboard API IFF present (absent in jsdom / insecure contexts). */
function api(): Clipboard | undefined {
  if (typeof navigator === 'undefined') return undefined
  const c = navigator.clipboard as Clipboard | undefined
  return c && typeof c.writeText === 'function' ? c : undefined
}

/**
 * Best-effort mirror of the in-app clipboard entry to the system clipboard
 * as tagged JSON. Never throws; failures (no permission / not focused /
 * insecure context) are swallowed and the in-memory slot remains canonical.
 */
export async function mirrorToSystemClipboard(entry: ClipboardEntry): Promise<void> {
  const c = api()
  if (!c) return
  try {
    await c.writeText(clipboardEntryToJSON(entry))
  } catch {
    // No clipboard permission / window not focused / insecure context.
  }
}

/**
 * Best-effort read of a sheet-llm clipboard entry from the system clipboard
 * (cross-tab/session paste). Returns null when the API is unavailable, the
 * read rejects, or the text isn't our tagged payload. Never throws.
 */
export async function readSystemClipboardEntry(): Promise<ClipboardEntry | null> {
  const c = api()
  if (!c || typeof c.readText !== 'function') return null
  try {
    return clipboardEntryFromJSON(await c.readText())
  } catch {
    return null
  }
}
