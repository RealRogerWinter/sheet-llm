'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore, type ContextTarget } from '@/lib/chat/state'
import { getVoiceEventAt } from '@/lib/music/scoreAccessors'
import { isRest } from '@/lib/music/eventKind'
import { classifyContextTarget } from './contextTarget'
import { contextMenuSections } from './contextMenuItems'
import { isContextMenuEnabled } from './contextMenuFlag'
import { createLongPress } from './useLongPress'
import { touchGestureBus } from './touchGestureBus'

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
  // Opening the menu through ANY path (mouse right-click, keyboard, or a
  // long-press on a note) ends any touch range-select session.
  touchGestureBus.disarmRange()
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
      // A native `contextmenu` that follows a touch/pen pointerdown is the
      // platform's own long-press menu (Android) — defer it to our pointer
      // timer, which fires regardless of platform and handles bars (arm range)
      // vs notes (open menu) uniformly. Mouse right-click never sets this
      // window, so desktop is unaffected.
      if (touchGestureBus.isTouchContextMenuPending()) {
        e.preventDefault()
        return
      }
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

    // Touch long-press: the iOS equivalent of right-click (iOS Safari never
    // fires `contextmenu` from a hold). A hold on a bar arms touch range-select
    // (a core gesture, NOT gated by the menu flag); a hold on a note/rest opens
    // the context menu (gated by the flag, like the mouse path). Either way it
    // suppresses the redundant Android-native `contextmenu`.
    function onLongPress(e: PointerEvent) {
      if (!container) return
      const store = useChatStore.getState()
      const editedScore = store.editedScore
      const editMap = store.editMap
      if (!editedScore || !editMap) return
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) return

      const target = classifyContextTarget(svg, e, editMap, editedScore, store.measureRangeSelection)

      if (target.kind === 'measure' || target.kind === 'barline') {
        store.selectMeasureRange({ fromStart: target.measureIdx, fromEnd: target.measureIdx })
        store.select(undefined)
        touchGestureBus.armRange()
        store.showStatusMessage(`Bar ${target.measureIdx + 1} — tap bars to extend the range`)
        return
      }

      // Note / rest / empty hold → behave like a right-click (flag-gated).
      // openForTarget disarms any prior range session.
      if (!isContextMenuEnabled()) return
      openForTarget(store, target, e.clientX, e.clientY)
    }

    const longPress = createLongPress({ onLongPress })

    // Capture phase so the timer starts even for holds on a notehead, where
    // useNoteDrag stop-propagates the bubbling pointerdown (a hold that then
    // moves >tolerance cancels and lets the drag proceed). The pointerdown also
    // opens the "context-menu came from touch" window so a native contextmenu
    // (Android) is deferred to this timer — see onContextMenu.
    function onPointerDownCapture(e: PointerEvent) {
      if (e.pointerType !== 'mouse') touchGestureBus.markTouchContextMenu()
      longPress.onPointerDown(e)
    }

    container.addEventListener('contextmenu', onContextMenu)
    container.addEventListener('pointerdown', onPointerDownCapture, true)
    container.addEventListener('pointermove', longPress.onPointerMove, true)
    container.addEventListener('pointerup', longPress.onPointerUp, true)
    container.addEventListener('pointercancel', longPress.onPointerCancel, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('pointerdown', onPointerDownCapture, true)
      container.removeEventListener('pointermove', longPress.onPointerMove, true)
      container.removeEventListener('pointerup', longPress.onPointerUp, true)
      container.removeEventListener('pointercancel', longPress.onPointerCancel, true)
      longPress.dispose()
      // End any touch range-select session when the interactive layer unmounts
      // so a module-global armed flag can't survive into a remount.
      touchGestureBus.disarmRange()
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [scoreRef, enabled])
}
