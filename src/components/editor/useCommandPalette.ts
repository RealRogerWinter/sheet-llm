'use client'

import { useEffect, useRef } from 'react'

/**
 * Wire Cmd+K (Mac) / Ctrl+K (everyone else) to open the command
 * palette. Capture-phase listener — same pattern as useShiftLetter-
 * Popover — so the shortcut beats any bubble-phase handlers that
 * might otherwise consume the key (e.g. a focused input).
 *
 * Conventional override behavior: fires REGARDLESS of focus target
 * (VS Code, Linear, GitHub, Notion all do this for ⌘K). The user
 * almost always wants the palette to open even when typing.
 *
 * `onOpen` is captured by ref so callers can pass inline closures
 * without re-attaching the document listener on every render. Match
 * the [[useShiftLetterPopover]] convention.
 */
export function useCommandPalette(onOpen: () => void): void {
  const onOpenRef = useRef(onOpen)
  // Keep the ref in sync with the latest onOpen WITHOUT triggering
  // listener re-attachment. The no-deps useEffect runs after every
  // render, mirroring React's official "always-current ref" pattern
  // (avoids the react-hooks/refs lint rule that flags direct ref
  // writes during render — see useShiftLetterPopover.ts for the
  // pre-existing baseline failure of the same pattern).
  useEffect(() => {
    onOpenRef.current = onOpen
  })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ⌘K (Mac) or Ctrl+K (Win/Linux). Bare K alone is reserved for
      // the Shift+K voltas popover; require the modifier here.
      if (e.key !== 'k' && e.key !== 'K') return
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.shiftKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      onOpenRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
