'use client'

import { useEffect, useRef } from 'react'

export interface UseShiftLetterPopoverOptions {
  /**
   * When false, the hook attaches no document listener — use for
   * `!!selection` gating so the shortcut only fires when an event
   * is selected.
   */
  enabled?: boolean
}

/**
 * Wire a Shift+letter keyboard shortcut to a popover opener — the
 * Dorico-style paradigm where Shift+D opens dynamics, Shift+P opens
 * performance technique, Shift+M opens meter, etc.
 *
 * Guards against firing while the user is typing in an input,
 * textarea, or contenteditable element — without this the prompt
 * bar would lose 'D' / 'P' keystrokes whenever a selection exists.
 *
 * Calls preventDefault + stopPropagation so the same key doesn't
 * also route through useEditorKeyboard's Shift+letter chord-stack
 * shortcut.
 *
 * The document listener is registered in CAPTURE phase. useEditor-
 * Keyboard attaches its own keydown listener on the score div in
 * bubble phase; without capture, a Shift+D on the focused score
 * would fire useEditorKeyboard first (target → bubble) and stack a
 * D pitch into the chord, then bubble up to document and ALSO open
 * the dynamics popover. Capture-phase listening lets the hook
 * stopPropagation BEFORE the target handler ever runs.
 *
 * `open` is captured by ref so callers can pass inline arrow
 * functions without re-attaching the document listener on every
 * render — important because the parent re-renders on every Zustand
 * selection change.
 *
 * @param letter the e.key value for the Shift+letter combo —
 *   typically uppercase ('D', 'P', 'F', 'M', 'T', 'K') since
 *   `KeyboardEvent.key` capitalises when Shift is held.
 */
export function useShiftLetterPopover(
  letter: string,
  open: () => void,
  { enabled = true }: UseShiftLetterPopoverOptions = {},
) {
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== letter || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      e.stopPropagation()
      openRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [letter, enabled])
}
