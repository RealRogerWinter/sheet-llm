'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore, type ContextTarget } from '@/lib/chat/state'
import { getVoiceEventAt } from '@/lib/music/scoreAccessors'
import { isRest } from '@/lib/music/eventKind'
import { classifyContextTarget } from './contextTarget'
import { contextMenuSections } from './contextMenuItems'
import { isContextMenuEnabled } from './contextMenuFlag'

type Store = ReturnType<typeof useChatStore.getState>

/**
 * Build a ContextTarget from the live store selection — used by the
 * keyboard opener, which has no pointer to hit-test. A per-event
 * selection becomes note / rest / chordNote; otherwise an active
 * measure-range becomes a `range` target.
 */
function targetFromStore(store: Store): ContextTarget | null {
  const { selection, measureRangeSelection, editedScore } = store
  if (selection && editedScore) {
    const event = getVoiceEventAt(
      editedScore,
      selection.staffIdx ?? 0,
      selection.voiceIdx ?? 0,
      selection.measureIdx,
      selection.eventIdx,
    )
    if (event) {
      if (isRest(event)) return { kind: 'rest', selection }
      if (event.pitches.length > 1 && selection.pitchIdx !== undefined) return { kind: 'chordNote', selection }
      return { kind: 'note', selection }
    }
  }
  if (measureRangeSelection) return { kind: 'range', range: measureRangeSelection }
  return null
}

/**
 * Apply the right selection for a target (so popovers anchor + the
 * highlight shows) and open the menu. Returns false when the target has
 * no items (caller leaves the native menu alone).
 */
function openForTarget(store: Store, target: ContextTarget, anchorX: number, anchorY: number): boolean {
  if (contextMenuSections(target).length === 0) return false
  if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
    store.select(target.selection)
  } else if (target.kind === 'measure' || target.kind === 'barline') {
    store.selectMeasureRange({ fromStart: target.measureIdx, fromEnd: target.measureIdx })
    store.select(undefined)
  } else if (target.kind === 'range') {
    store.select(undefined)
  }
  store.openContextMenu({ target, anchorX, anchorY })
  return true
}

/**
 * Mount-once right-click + keyboard context-menu wiring on the score
 * container (M27). On `contextmenu` (mouse right-click or touch
 * long-press, which fires the same event) it classifies the cursor
 * target and opens the menu; on the `ContextMenu` key / `Shift+F10` it
 * opens for the current selection at its last-click anchor.
 *
 * Gated on `enabled` (only the interactive ScorePanel, never the
 * outgoing crossfade layer) AND the `NEXT_PUBLIC_SL_CONTEXT_MENU` flag
 * (default off while dark-launched). Store reads happen via `getState()`
 * inside the handlers so the listeners never tear down on edits — mirrors
 * `useStaffInteractions` / `useNoteDrag`.
 */
export function useScoreContextMenu(scoreRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const container = scoreRef.current
    if (!container) return

    function onContextMenu(e: MouseEvent) {
      if (!container) return
      if (!isContextMenuEnabled()) return
      // macOS Ctrl+click synthesizes a contextmenu event but is owned by
      // useMeasureRangeSelect — let it through to the native menu rather
      // than double-firing both gestures (Open Decision A).
      if (e.ctrlKey || e.metaKey) return

      const store = useChatStore.getState()
      const editedScore = store.editedScore
      const editMap = store.editMap
      if (!editedScore || !editMap) return
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) return

      const target = classifyContextTarget(svg, e, editMap, editedScore, store.measureRangeSelection)
      if (openForTarget(store, target, e.clientX, e.clientY)) e.preventDefault()
    }

    // Keyboard: ContextMenu key / Shift+F10 open the menu for the current
    // selection at its last-click anchor (or screen-center fallback).
    // Capture phase so it beats focused-element handlers, mirroring
    // useCommandPalette.
    function onKeyDown(e: KeyboardEvent) {
      if (!isContextMenuEnabled()) return
      const isContextKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
      if (!isContextKey) return
      const store = useChatStore.getState()
      const target = targetFromStore(store)
      if (!target) return
      const sel = 'selection' in target ? target.selection : undefined
      const anchorX = sel?.anchorX ?? window.innerWidth / 2
      const anchorY = sel?.anchorY ?? 160
      if (openForTarget(store, target, anchorX, anchorY)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    container.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      container.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [scoreRef, enabled])
}
