'use client'

import { useChatStore } from '@/lib/chat/state'
import { getMeasureCount } from '@/lib/music/scoreAccessors'
import type { ImportResponse } from '@/lib/shared/types'

/**
 * Quick-import helper used by the debug panel: posts to /api/import,
 * seats the response into the chat store via resolveImport, and
 * returns a status string for the caller to display.
 *
 * Bypasses the ImportModal entirely (no preview, no confirm). Intended
 * for developer testing only — wired into DebugPanel behind the same
 * gating flag as the rest of the panel.
 */
export async function quickImportFromUrl(url: string, filename?: string): Promise<string> {
  const fileText = await (await fetch(url)).text()
  return quickImportText(fileText, filename ?? url.split('/').pop() ?? 'sample.abc', 'abc')
}

export async function quickImportText(
  text: string,
  filename: string,
  format: 'abc' | 'json',
  options: { truncateIfLong?: boolean } = {},
): Promise<string> {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format, text, filename, truncateIfLong: options.truncateIfLong ?? false }),
  })
  if (res.status === 422) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return `blocked: ${data.error ?? 'import failed'}`
  }
  if (!res.ok) {
    return `error: HTTP ${res.status}`
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
  useChatStore.getState().showUndoToast(
    `Imported ${data.filename ?? 'score'} · ${getMeasureCount(data.scoreJson!)} bars`,
  )
  const warnSuffix = data.warnings.length > 0 ? ` (${data.warnings.length} warning${data.warnings.length === 1 ? '' : 's'})` : ''
  return `loaded${warnSuffix}`
}
