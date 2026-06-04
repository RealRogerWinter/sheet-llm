'use client'

import { useEffect, type RefObject } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { getStaffEventAt } from '@/lib/music/scoreAccessors'
import { mapKey, pitchForStackKey } from './keyboardShortcuts'

/**
 * Install a keydown listener on the element behind `targetRef` that
 * maps recognized shortcuts to store actions. Skips events whose
 * target is an input/textarea/contenteditable so PromptBar typing
 * isn't hijacked.
 */
export function useEditorKeyboard(targetRef: RefObject<HTMLElement | null>) {
  const selection = useChatStore((s) => s.selection)
  const measureRangeSelection = useChatStore((s) => s.measureRangeSelection)
  const applyEdit = useChatStore((s) => s.applyEdit)
  const applyBalancedEdit = useChatStore((s) => s.applyBalancedEdit)
  const undo = useChatStore((s) => s.undo)
  const redo = useChatStore((s) => s.redo)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return
      }

      // Shift+A..G: stack the named pitch into the selected event's
      // chord. Octave is inherited from the currently-focused pitch.
      // Coalesced under a single key so rapid stacks are one undo.
      if (selection && e.shiftKey) {
        const score = useChatStore.getState().editedScore
        const event = score
          ? getStaffEventAt(score, selection.staffIdx ?? 0, selection.measureIdx, selection.eventIdx)
          : undefined
        const focused = event?.pitches[selection.pitchIdx ?? 0]
        const top = event?.pitches[event.pitches.length - 1] ?? focused
        const pitch = pitchForStackKey(e, top)
        if (pitch && event && event.pitches[0]?.step !== 'rest') {
          e.preventDefault()
          try {
            applyEdit(
              { kind: 'addPitchToChord', target: selection, pitch },
              `chord-stack:${selection.measureIdx}:${selection.eventIdx}`,
            )
          } catch {
            /* over cap / duplicate — applyEdit's error toast will surface it */
          }
          return
        }
      }

      const result = mapKey(e, selection, measureRangeSelection)
      if (!result) return
      e.preventDefault()
      if ('kind' in result) {
        switch (result.kind) {
          case 'undo': undo(); break
          case 'redo': redo(); break
          case 'toggleCheatSheet': useChatStore.getState().toggleCheatSheet(); break
          case 'toggleChordPalette': useChatStore.getState().toggleChordPalette(); break
          case 'clearSelection':
            useChatStore.getState().select(undefined)
            useChatStore.getState().selectMeasureRange(undefined)
            break
          case 'setActiveDuration': useChatStore.getState().setActiveDuration(result.duration); break
          case 'toggleActiveDotted': useChatStore.getState().toggleActiveDotted(); break
          case 'setActiveAccidental': useChatStore.getState().setActiveAccidental(result.accidental); break
          case 'requestMeasureDelete':
            useChatStore
              .getState()
              .requestMeasureDelete({ fromStart: result.fromStart, fromEnd: result.fromEnd })
            break
        }
      } else if ('op' in result) {
        // Route bar-changing ops through applyBalancedEdit so the
        // measure stays meter-valid after the edit. `transformScore`
        // (used by applyEdit) is meter-blind and would silently leave
        // the bar short by the duration delta or the removed event.
        const op = result.op
        if (op.kind === 'changeDuration') {
          applyBalancedEdit(
            { kind: 'changeDurationBalanced', selection: op.target, duration: op.duration },
            result.coalesce,
          )
        } else if (op.kind === 'deleteEvent') {
          applyBalancedEdit(
            { kind: 'removeBalanced', selection: op.target },
            result.coalesce,
          )
        } else {
          applyEdit(op, result.coalesce)
        }
      }
    }
    target.addEventListener('keydown', onKeyDown)
    return () => target.removeEventListener('keydown', onKeyDown)
  }, [targetRef, selection, measureRangeSelection, applyEdit, applyBalancedEdit, undo, redo])
}
