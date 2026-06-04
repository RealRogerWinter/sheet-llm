import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useEditorKeyboard } from '@/components/editor/useEditorKeyboard'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

/**
 * Wire-path tests for useEditorKeyboard (M19-PR-6). The mapKey
 * pure-function logic is covered in keyboardShortcuts.test.ts; this
 * file pins the dispatch wiring — that Esc clears BOTH selections,
 * that bar-range shortcuts route through the range slot, etc.
 */

const SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
  ],
}

function seed() {
  useChatStore.setState({
    chatId: 'test',
    abc: 'X:1\n',
    scoreJson: SCORE,
    editedScore: SCORE,
    editMap: undefined,
    selection: undefined,
    measureRangeSelection: undefined,
    pendingMeasureDelete: undefined,
    history: [SCORE],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    pending: false,
    error: undefined,
  })
}

function mountKeyboard(): HTMLDivElement {
  const div = document.createElement('div')
  document.body.appendChild(div)
  renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(div)
    useEditorKeyboard(ref)
  })
  return div
}

describe('useEditorKeyboard — clearSelection clears BOTH selections (M19-PR-6)', () => {
  beforeEach(seed)
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('Escape clears per-event selection AND measure range', () => {
    useChatStore.getState().select({ measureIdx: 0, eventIdx: 0 })
    useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 2 })
    expect(useChatStore.getState().selection).toBeDefined()
    expect(useChatStore.getState().measureRangeSelection).toBeDefined()

    const target = mountKeyboard()
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(useChatStore.getState().selection).toBeUndefined()
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
  })

  it('Escape with only per-event selection still clears it', () => {
    useChatStore.getState().select({ measureIdx: 0, eventIdx: 0 })
    const target = mountKeyboard()
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(useChatStore.getState().selection).toBeUndefined()
  })

  it('Escape with only measure range still clears it', () => {
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    const target = mountKeyboard()
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(useChatStore.getState().measureRangeSelection).toBeUndefined()
  })

  it('Shift+Backspace with only a measure range opens the confirm gate (no immediate mutation)', () => {
    // Pins the M19-PR-6 wire-path: no per-event selection, only a
    // range. Keyboard event flows through mapKey → the requestMeasureDelete
    // StoreAction, which stages the confirm gate rather than mutating
    // the score directly (always-confirm).
    useChatStore.getState().selectMeasureRange({ fromStart: 1, fromEnd: 2 })
    const target = mountKeyboard()
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', shiftKey: true, bubbles: true }),
    )
    // Gate is staged; score is untouched until confirm.
    expect(useChatStore.getState().pendingMeasureDelete).toEqual({ fromStart: 1, fromEnd: 2 })
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(3)
    // Confirming performs the delete.
    useChatStore.getState().confirmMeasureDelete()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(1)
    expect(
      useChatStore.getState().editedScore?.measures[0].events[0].pitches[0].step,
    ).toBe('C')
  })

  it('plain Backspace with only a measure range opens the confirm gate', () => {
    // The new plain-Delete affordance: a Ctrl/Cmd-clicked bar (range set,
    // no event selection) deletes via plain Backspace, through the gate.
    useChatStore.getState().selectMeasureRange({ fromStart: 2, fromEnd: 2 })
    const target = mountKeyboard()
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    expect(useChatStore.getState().pendingMeasureDelete).toEqual({ fromStart: 2, fromEnd: 2 })
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(3)
  })

  it('plain Backspace with an event selected deletes the EVENT, not the bar', () => {
    // Granular intent wins: an event selection means plain Delete removes
    // the event (no measure-delete gate), even if a range is also set.
    useChatStore.getState().select({ measureIdx: 0, eventIdx: 0 })
    useChatStore.getState().selectMeasureRange({ fromStart: 0, fromEnd: 2 })
    const target = mountKeyboard()
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    // No gate opened; the bar count is unchanged (event removed within bar 0).
    expect(useChatStore.getState().pendingMeasureDelete).toBeUndefined()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(3)
  })
})
