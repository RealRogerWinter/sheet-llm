'use client'

import { useEffect, useRef } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { getMeasureCount } from '@/lib/music/scoreAccessors'
import ImportDropzone from './ImportDropzone'
import ImportPasteBox from './ImportPasteBox'
import ImportSamples from './ImportSamples'
import ImportPreview from './ImportPreview'
import ImportSummary from './ImportSummary'
import { useImport } from './useImport'
import styles from './ImportModal.module.css'

interface ImportModalProps {
  onClose: () => void
}

function detectPasteFormat(text: string): 'abc' | 'json' {
  const t = text.trim()
  if (t.startsWith('{')) return 'json'
  return 'abc'
}

export default function ImportModal({ onClose }: ImportModalProps) {
  const resolveImport = useChatStore((s) => s.resolveImport)
  const showUndoToast = useChatStore((s) => s.showUndoToast)
  const hasScore = useChatStore((s) => Boolean(s.abc))
  const { state, parse, reset, acceptTruncation, setLayoutOverride } = useImport()

  const dialogRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // Esc to dismiss + focus management. Trap is best-effort (full
  // implementations are fiddly); the close button gets initial focus
  // and Esc always works.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    closeBtnRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function commit() {
    if (state.status !== 'preview-ready' || !state.preview) return
    const p = state.preview
    resolveImport({
      chatId: p.chatId,
      abc: p.abc,
      scoreJson: p.scoreJson,
      introText: p.introText,
      importFormat: p.importFormat,
      filename: p.filename,
    })
    showUndoToast(`Imported ${p.filename ?? 'score'} · ${getMeasureCount(p.scoreJson)} bars`)
    onClose()
  }

  const busy = state.status === 'previewing'
  const canCommit = state.status === 'preview-ready' && !!state.preview

  return (
    <div className={styles.scrim} role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="import-title" className={styles.title}>Import score</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close import dialog"
          >
            ×
          </button>
        </div>

        {hasScore && (
          <div className={styles.replaceWarn} role="status">
            Importing will replace the current score and start a new conversation.
          </div>
        )}

        <div className={styles.body}>
          <ImportDropzone onFile={(f) => parse({ kind: 'file', file: f })} disabled={busy} />

          <ImportPasteBox
            onParse={(text) =>
              parse({ kind: 'paste', format: detectPasteFormat(text), text })
            }
            disabled={busy}
          />

          <ImportSamples
            onPick={(s) =>
              parse({ kind: 'paste', format: 'abc', text: s.text, filename: s.filename })
            }
            disabled={busy}
          />

          {busy && (
            <div className={styles.busy} role="status">Parsing…</div>
          )}

          {state.error && state.warnings.length === 0 && (
            <div className={styles.error} role="alert">{state.error}</div>
          )}

          {state.warnings.length > 0 && (
            <ImportSummary
              warnings={state.warnings}
              onAcceptTruncation={state.pendingChoice ? acceptTruncation : undefined}
            />
          )}

          {state.preview && (
            <ImportPreview
              abc={state.preview.abc}
              score={state.preview.scoreJson}
              format={state.preview.importFormat}
              filename={state.preview.filename}
              onLayoutOverride={setLayoutOverride}
            />
          )}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={commit}
            disabled={!canCommit}
            aria-disabled={!canCommit}
          >
            Import this score
          </button>
        </div>
      </div>
    </div>
  )
}
