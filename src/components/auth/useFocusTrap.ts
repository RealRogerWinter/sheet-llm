'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Minimal focus trap for a modal `<form>` dialog. On activate: remembers the
 * previously-focused element and moves focus inside `containerRef`; Tab /
 * Shift+Tab wrap within the container; Escape calls `onClose`; on deactivate it
 * restores focus to where it was.
 *
 * Deliberately does NOT (a) add a GLOBAL capture-phase key handler — that's the
 * MeasureDeleteConfirmModal bug that would hijack the form's own Enter-submit —
 * and (b) close on backdrop click. The listener is scoped to the container, so
 * it only runs while focus is trapped inside.
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return
    const current = containerRef.current
    if (!current) return
    // Explicit non-null binding so the hoisted onKeyDown closure keeps the type.
    const trap: HTMLElement = current
    const previouslyFocused = document.activeElement as HTMLElement | null

    // Every focusable inside an OPEN dialog is visible, so we don't filter by
    // offsetParent (which is unreliably null inside position:fixed ancestors and
    // always null in jsdom) — we only skip explicitly hidden subtrees.
    const focusables = (): HTMLElement[] =>
      Array.from(trap.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.closest('[hidden],[aria-hidden="true"]'),
      )

    const initial = focusables()[0]
    if (initial) initial.focus()
    else {
      trap.tabIndex = -1
      trap.focus()
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const activeEl = document.activeElement
      if (e.shiftKey && (activeEl === first || !trap.contains(activeEl))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }

    trap.addEventListener('keydown', onKeyDown)
    return () => {
      trap.removeEventListener('keydown', onKeyDown)
      try {
        previouslyFocused?.focus()
      } catch {
        // the previously-focused element is gone — nothing to restore
      }
    }
  }, [active, containerRef, onClose])
}
