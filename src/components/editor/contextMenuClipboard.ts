'use client'

import { useChatStore, type ClipboardEntry, type ContextTarget, type RunSelection } from '@/lib/chat/state'
import {
  copyEventRun,
  copyEventSelection,
  copyMeasureRange,
  pasteMeasuresInsertOp,
  pasteMeasuresReplaceOp,
  removeEventRun,
} from '@/lib/chat/clipboard'
import { pasteEvents } from '@/lib/music/pasteEvents'
import { mirrorToSystemClipboard, readSystemClipboardEntry } from './systemClipboard'

type Store = ReturnType<typeof useChatStore.getState>

/**
 * The active intra-measure run (D2) IF it covers the right-clicked event
 * target — same voice/measure and the clicked event inside `[start, end]`.
 * When set, Copy/Cut operate on the whole run instead of the single event.
 */
function runForTarget(store: Store, target: ContextTarget): RunSelection | undefined {
  const run = store.runSelection
  if (!run) return undefined
  if (target.kind !== 'note' && target.kind !== 'rest' && target.kind !== 'chordNote') return undefined
  const s = target.selection
  if ((s.staffIdx ?? 0) !== (run.staffIdx ?? 0)) return undefined
  if ((s.voiceIdx ?? 0) !== (run.voiceIdx ?? 0)) return undefined
  if (s.measureIdx !== run.measureIdx) return undefined
  const lo = Math.min(run.startEventIdx, run.endEventIdx)
  const hi = Math.max(run.startEventIdx, run.endEventIdx)
  return s.eventIdx >= lo && s.eventIdx <= hi ? run : undefined
}

/** The clipboard entry for the target, or null when nothing is copyable. */
function entryForTarget(store: Store, target: ContextTarget): ClipboardEntry | null {
  const score = store.editedScore
  if (!score) return null
  if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
    const run = runForTarget(store, target)
    return run ? copyEventRun(score, run) : copyEventSelection(score, target.selection)
  }
  if (target.kind === 'measure' || target.kind === 'barline') {
    return copyMeasureRange(score, { fromStart: target.measureIdx, fromEnd: target.measureIdx })
  }
  if (target.kind === 'range') return copyMeasureRange(score, target.range)
  return null
}

/**
 * Copy the target to the in-memory `clipboard` slot (canonical) AND mirror
 * it to the system clipboard (D3, best-effort, fire-and-forget). Returns
 * false when nothing is copyable.
 */
function copyForTarget(store: Store, target: ContextTarget): boolean {
  const entry = entryForTarget(store, target)
  if (!entry) return false
  store.setClipboard(entry)
  void mirrorToSystemClipboard(entry)
  return true
}

/** True when `id` is a Cut/Copy/Paste verb handled by `runClipboardItem`. */
export function isClipboardItem(id: string): boolean {
  return id === 'cut' || id === 'copy' || id === 'paste'
}

/**
 * Dispatch a Cut / Copy / Paste menu item for the right-clicked target
 * (M28). Cut = copy (non-mutating) + exactly one mutating delete, so it is
 * a single undo step. Copy also mirrors to the system clipboard (D3). Paste
 * prefers the in-memory slot and falls back to a foreign system-clipboard
 * entry; it routes by clipboard kind (`events` → balanced `pasteEvents` via
 * `applyScore`; `measures` → insert/replace ops via `applyEdit`).
 *
 * Async because the foreign-paste fallback awaits the Clipboard API. The
 * in-memory paste path takes no await, so the common case still commits
 * synchronously; callers fire-and-forget (the returned promise is ignored).
 */
export async function runClipboardItem(id: string, target: ContextTarget): Promise<void> {
  const store = useChatStore.getState()

  if (id === 'copy') {
    copyForTarget(store, target)
    return
  }

  if (id === 'cut') {
    if (!copyForTarget(store, target)) return
    if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
      const run = runForTarget(store, target)
      const score = store.editedScore
      if (run && score) {
        // Cut-run: replace the run with rests (meter-preserving) in one
        // undo step, then drop the now-stale run selection.
        store.applyScore(removeEventRun(score, run))
        store.selectRun(undefined)
      } else {
        store.applyBalancedEdit({ kind: 'removeBalanced', selection: target.selection })
      }
    } else if (target.kind === 'measure' || target.kind === 'barline') {
      store.requestMeasureDelete({ fromStart: target.measureIdx, fromEnd: target.measureIdx })
    } else if (target.kind === 'range') {
      store.requestMeasureDelete(target.range)
    }
    return
  }

  await runPaste(store, target)
}

/**
 * Paste path. Prefer the in-memory `clipboard` slot; when empty, read a
 * foreign sheet-llm entry from the system clipboard (D3) and adopt it. Then
 * re-read fresh store state (the score may have changed across the await)
 * and dispatch by clipboard kind.
 */
async function runPaste(store: Store, target: ContextTarget): Promise<void> {
  let clip = store.clipboard
  if (!clip) {
    const foreign = await readSystemClipboardEntry()
    if (foreign) {
      useChatStore.getState().setClipboard(foreign)
      clip = foreign
    }
  }
  if (!clip) return

  const s = useChatStore.getState()
  const score = s.editedScore
  if (!score) return

  if (clip.kind === 'events') {
    let dest: { staffIdx: number; voiceIdx: number; measureIdx: number; insertAfterIdx: number } | undefined
    if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
      const sel = target.selection
      dest = { staffIdx: sel.staffIdx ?? 0, voiceIdx: sel.voiceIdx ?? 0, measureIdx: sel.measureIdx, insertAfterIdx: sel.eventIdx }
    } else if (target.kind === 'measure') {
      dest = { staffIdx: target.staffIdx, voiceIdx: 0, measureIdx: target.measureIdx, insertAfterIdx: target.insertAfterIdx }
    }
    if (!dest) return
    const res = pasteEvents(score, dest, clip.events)
    if (res.ok) s.applyScore(res.score, { selection: res.newSelection, statusMessage: res.statusMessage })
    else if (res.statusMessage) s.showStatusMessage(res.statusMessage)
    return
  }

  // measures clipboard → insert after a bar / replace a range
  if (target.kind === 'measure') {
    s.applyEdit(pasteMeasuresInsertOp(clip.captured, target.measureIdx))
  } else if (target.kind === 'range') {
    s.applyEdit(pasteMeasuresReplaceOp(clip.captured, target.range.fromStart, target.range.fromEnd))
  }
}
