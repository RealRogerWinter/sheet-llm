'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { effectiveActiveDuration, useChatStore, type ContextMenuState } from '@/lib/chat/state'
import type { Accidental, Duration, Pitch } from '@/lib/music/types'
import { getStaffClef, getVoiceEventAt } from '@/lib/music/scoreAccessors'
import { smartInsertNote } from '@/lib/music/smartInsertNote'
import { contextMenuSections } from './contextMenuItems'
import { isAiEntryEnabled, isClipboardEnabled } from './contextMenuFlag'
import { isClipboardItem, runClipboardItem } from './contextMenuClipboard'
import { isAiItem, runAiItem } from './contextMenuAi'
import styles from './ContextMenu.module.css'

const MENU_WIDTH = 240
const ITEM_HEIGHT = 28

/**
 * Right-click context menu (M27). Mounts the panel when the `contextMenu`
 * store slot is set (by `useScoreContextMenu`). Keyed by the cursor anchor
 * so each open remounts the panel — the active item resets, focus is
 * re-captured, and the dismissal listeners re-bind cleanly without any
 * setState-in-effect.
 */
export function ContextMenu() {
  const contextMenu = useChatStore((s) => s.contextMenu)
  if (!contextMenu) return null
  const key = `${contextMenu.anchorX}:${contextMenu.anchorY}:${contextMenu.target.kind}`
  return <ContextMenuPanel key={key} state={contextMenu} />
}

/**
 * A vertical, cursor-anchored menu whose items dispatch the SAME store
 * actions the left-click NoteFloatingMenu toolbar uses (`applyEdit` /
 * `applyBalancedEdit` / `playFromSelection` / the `paletteRequest` bus) —
 * the menu is routing, not new editing logic.
 *
 * Dismissal: Escape (capture-phase, stop-propagated so it doesn't also
 * clear the underlying selection), outside mousedown, firing any item,
 * and any scroll / wheel / zoom / resize (which stales the cursor anchor).
 *
 * Keyboard (M27-PR-5): the container holds focus; ArrowUp/Down (wrap),
 * Home/End move the active descendant; Enter/Space fire it. Focus is
 * captured on mount and restored to the prior element on unmount (close).
 */
function ContextMenuPanel({ state }: { state: ContextMenuState }) {
  const editedScore = useChatStore((s) => s.editedScore)
  const clipboardKind = useChatStore((s) => s.clipboard?.kind)
  const close = useChatStore((s) => s.closeContextMenu)
  const menuRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const { target, anchorX, anchorY } = state
  const sel = 'selection' in target ? target.selection : undefined
  const event =
    sel && editedScore
      ? getVoiceEventAt(editedScore, sel.staffIdx ?? 0, sel.voiceIdx ?? 0, sel.measureIdx, sel.eventIdx)
      : undefined
  const sections = contextMenuSections(target, {
    eventHasId: event?.id !== undefined,
    clipboardEnabled: isClipboardEnabled(),
    clipboardKind,
    aiEnabled: isAiEntryEnabled(),
  })
  const flatItems = sections.flatMap((s) => s.items)
  const n = flatItems.length

  // Capture prior focus + focus the menu on mount; restore on unmount.
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    menuRef.current?.focus()
    return () => prior?.focus?.()
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node | null
      if (t && menuRef.current?.contains(t)) return
      close()
    }
    // Any scroll / wheel / zoom-reflow / resize moves the score under the
    // menu, so the cursor anchor goes stale → close.
    function onReflow() {
      close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('wheel', onReflow, { passive: true, capture: true })
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('wheel', onReflow, true)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [close])

  if (sections.length === 0) return null

  const estHeight = n * ITEM_HEIGHT + sections.length * 14 + 16
  const left = Math.max(8, Math.min(anchorX, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.max(8, Math.min(anchorY, window.innerHeight - estHeight - 8))

  function run(id: string) {
    const store = useChatStore.getState()

    // M28 clipboard verbs (cut / copy / paste) dispatch uniformly across
    // target kinds.
    if (isClipboardItem(id)) {
      // Async only for the D3 foreign-paste fallback; the in-memory path
      // commits synchronously. Fire-and-forget — the menu closes now.
      void runClipboardItem(id, target)
      store.closeContextMenu()
      return
    }

    if (isAiItem(id)) {
      runAiItem(id, target)
      store.closeContextMenu()
      return
    }

    // Structural targets (measure / barline / range) carry their indices
    // on the target rather than a per-event selection.
    if (target.kind === 'measure' || target.kind === 'barline') {
      const mi = target.measureIdx
      const staffIdx = target.staffIdx
      if (id === 'measure:select') {
        store.selectMeasureRange({ fromStart: mi, fromEnd: mi })
      } else if (id === 'measure:delete') {
        store.requestMeasureDelete({ fromStart: mi, fromEnd: mi })
      } else if (id === 'measure:insert' && target.kind === 'measure') {
        const score = store.editedScore
        if (score) {
          const clef = getStaffClef(score, staffIdx)
          const pitch: Pitch = clef === 'bass' ? { step: 'F', octave: 3 } : { step: 'C', octave: 4 }
          const result = smartInsertNote(
            score,
            { measureIdx: mi, eventIdx: target.insertAfterIdx },
            { pitches: [pitch], duration: effectiveActiveDuration(store.activeDuration, store.activeDotted) },
            staffIdx,
            0,
          )
          store.applyScore(result.score, { selection: result.newSelection, statusMessage: result.statusMessage })
        }
      } else if (id === 'open-barline' || id === 'open-volta' || id === 'open-jump-marker') {
        // The NoteFloatingMenu bus subscriber snapshots selection.measureIdx,
        // so set a per-event selection on the measure before publishing.
        store.select({ staffIdx, measureIdx: mi, eventIdx: 0, anchorX, anchorY })
        store.setPaletteRequest({ kind: id })
      }
      store.closeContextMenu()
      return
    }

    if (target.kind === 'range') {
      if (id === 'range:delete') store.requestMeasureDelete(target.range)
      store.closeContextMenu()
      return
    }

    // note / rest / chordNote — per-event selection.
    if (sel) {
      if (id === 'play') store.playFromSelection(sel)
      else if (id.startsWith('acc:'))
        store.applyEdit({ kind: 'setAccidental', target: sel, accidental: id.slice(4) as Accidental })
      else if (id.startsWith('dur:'))
        store.applyBalancedEdit({ kind: 'changeDurationBalanced', selection: sel, duration: id.slice(4) as Duration })
      else if (id.startsWith('bus:'))
        // Generic paletteRequest opener; the kind suffix is a verified
        // PaletteRequest['kind'] (see contextMenuItems). The single-member
        // cast satisfies the discriminated-union arg without per-kind cases.
        store.setPaletteRequest({ kind: id.slice(4) } as { kind: 'open-dynamics' })
      else if (id === 'remove-from-chord')
        store.applyEdit({ kind: 'removePitchFromChord', target: sel, pitchIdx: sel.pitchIdx ?? 0 })
      else if (id === 'delete') store.applyBalancedEdit({ kind: 'removeBalanced', selection: sel })
    }
    store.closeContextMenu()
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % n)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + n) % n)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(n - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item && !item.disabled) run(item.id)
    }
  }

  const activeId = flatItems[activeIndex] ? `cm-item-${activeIndex}` : undefined

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label="Score context menu"
      tabIndex={-1}
      aria-activedescendant={activeId}
      style={{ left, top, width: MENU_WIDTH }}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sections.map((section, si) => (
        <div key={si} className={styles.section} role="group" aria-label={section.label}>
          {section.label ? <div className={styles.sectionLabel}>{section.label}</div> : null}
          {section.items.map((item) => {
            const idx = flatItems.findIndex((fi) => fi.id === item.id)
            const isActive = idx === activeIndex
            return (
              <button
                key={item.id}
                id={`cm-item-${idx}`}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${styles.item} ${item.danger ? styles.danger : ''} ${isActive ? styles.active : ''}`}
                disabled={item.disabled}
                onClick={() => run(item.id)}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
