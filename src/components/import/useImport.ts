'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Score } from '@/lib/music/types'
import type {
  ImportErrorResponse,
  ImportFormat,
  ImportResponse,
  ImportWarningWire,
} from '@/lib/shared/types'

export type ImportSource =
  | { kind: 'file'; file: File }
  | { kind: 'paste'; format: 'abc' | 'json'; text: string; filename?: string }

export interface ParsedPreview {
  abc: string
  scoreJson: Score
  warnings: ImportWarningWire[]
  importFormat: ImportFormat
  filename?: string
  /** Server-issued chatId — set after a successful preview parse; the
   *  same id is reused on commit so the seed turn isn't re-created. */
  chatId: string
  toolUseId?: string
  introText?: string
}

type Status = 'idle' | 'previewing' | 'preview-ready' | 'preview-blocked' | 'error'

interface UseImportState {
  status: Status
  preview?: ParsedPreview
  warnings: ImportWarningWire[]
  error?: string
  /** When the server blocks on a `too_long` choice, hold the original
   *  source so the user can re-submit with truncateIfLong=true. */
  pendingChoice?: { source: ImportSource; reason: 'too_long' }
  /** The last source the user submitted. Used by setLayoutOverride
   *  so the UI can re-import with a different layout without asking
   *  the user to re-pick the file/paste. */
  lastSource?: ImportSource
}

/**
 * Drives the import modal's I/O against /api/import. Two flows:
 *
 *   parse(source)       — submit a file / paste and produce a preview.
 *                          Block warnings stay in `state.warnings` and
 *                          status becomes 'preview-blocked'.
 *   parse(source, true) — re-submit with truncateIfLong=true after the
 *                          user accepts truncation.
 *
 * On a clean preview, status is 'preview-ready' and the modal renders
 * the preview + commit button. The commit step (handled by the caller)
 * simply lifts `preview` into the chat store via `resolveImport` — no
 * further server round-trip is needed because the seed conversation
 * already exists.
 */
export function useImport() {
  const [state, setState] = useState<UseImportState>({ status: 'idle', warnings: [] })
  const abortRef = useRef<AbortController | undefined>(undefined)

  // Cancel any in-flight parse on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = undefined
    setState({ status: 'idle', warnings: [] })
  }, [])

  const parse = useCallback(
    async (
      source: ImportSource,
      opts: { truncateIfLong?: boolean; layoutOverride?: 'single' | 'grand-staff' | 'satb' } = {},
    ) => {
      const truncateIfLong = opts.truncateIfLong ?? false
      const layoutOverride = opts.layoutOverride
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setState({ status: 'previewing', warnings: [], lastSource: source })

      try {
        let res: Response
        if (source.kind === 'file') {
          const fd = new FormData()
          fd.append('file', source.file)
          if (truncateIfLong) fd.append('truncateIfLong', 'true')
          if (layoutOverride) fd.append('layoutOverride', layoutOverride)
          res = await fetch('/api/import', { method: 'POST', body: fd, signal: ctrl.signal })
        } else {
          res = await fetch('/api/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              format: source.format,
              text: source.text,
              filename: source.filename,
              truncateIfLong,
              ...(layoutOverride ? { layoutOverride } : {}),
            }),
            signal: ctrl.signal,
          })
        }

      if (res.status === 422) {
        const data = (await res.json().catch(() => ({}))) as ImportErrorResponse
        const warnings = data.warnings ?? []
        const tooLong = warnings.find((w) => w.code === 'too_long' && w.severity === 'block')
        setState({
          status: 'preview-blocked',
          warnings,
          error: data.error,
          lastSource: source,
          ...(tooLong ? { pendingChoice: { source, reason: 'too_long' } } : {}),
        })
        return
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setState({
          status: 'error',
          warnings: [],
          error: data.error ?? `Import failed: ${res.status}`,
        })
        return
      }
      const data = (await res.json()) as ImportResponse
      setState({
        status: 'preview-ready',
        warnings: data.warnings,
        lastSource: source,
        preview: {
          abc: data.abc,
          scoreJson: data.scoreJson!,
          warnings: data.warnings,
          importFormat: data.importFormat,
          filename: data.filename,
          chatId: data.chatId,
          toolUseId: data.toolUseId,
          introText: data.introText,
        },
      })
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      setState({
        status: 'error',
        warnings: [],
        error: e instanceof Error ? e.message : 'Network error',
      })
    }
  }, [])

  const acceptTruncation = useCallback(() => {
    if (state.pendingChoice) parse(state.pendingChoice.source, { truncateIfLong: true })
  }, [parse, state.pendingChoice])

  /**
   * Re-run the import with a different layout override. Reuses the
   * last source (file or paste) so the user doesn't have to re-pick
   * the file just to flip the layout.
   */
  const setLayoutOverride = useCallback(
    (layout: 'single' | 'grand-staff' | 'satb') => {
      if (!state.lastSource) return
      parse(state.lastSource, { layoutOverride: layout })
    },
    [parse, state.lastSource],
  )

  return { state, parse, reset, acceptTruncation, setLayoutOverride }
}
