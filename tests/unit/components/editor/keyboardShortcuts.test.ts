import { describe, it, expect } from 'vitest'
import { mapKey, pitchForStackKey } from '@/components/editor/keyboardShortcuts'
import type { Selection } from '@/lib/chat/state'
import type { Pitch } from '@/lib/music/types'

function ev(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
  } as KeyboardEvent
}

const SEL: Selection = { measureIdx: 0, eventIdx: 0, pitchIdx: 0 }

describe('mapKey — picker shortcuts (no selection)', () => {
  it('1..6 set the active duration when nothing is selected', () => {
    expect(mapKey(ev({ key: '4' }), undefined)).toEqual({ kind: 'setActiveDuration', duration: 'quarter' })
    expect(mapKey(ev({ key: '6' }), undefined)).toEqual({ kind: 'setActiveDuration', duration: 'whole' })
    expect(mapKey(ev({ key: '1' }), undefined)).toEqual({ kind: 'setActiveDuration', duration: '32nd' })
  })

  it("=/-/0 set the active accidental when nothing is selected", () => {
    expect(mapKey(ev({ key: '=' }), undefined)).toEqual({ kind: 'setActiveAccidental', accidental: 'sharp' })
    expect(mapKey(ev({ key: '-' }), undefined)).toEqual({ kind: 'setActiveAccidental', accidental: 'flat' })
    expect(mapKey(ev({ key: '0' }), undefined)).toEqual({ kind: 'setActiveAccidental', accidental: 'natural' })
  })

  it("'.' toggles the active dotted flag when nothing is selected", () => {
    expect(mapKey(ev({ key: '.' }), undefined)).toEqual({ kind: 'toggleActiveDotted' })
  })

  it('with a selection, 1..6 still apply the duration EDIT to that selection', () => {
    const result = mapKey(ev({ key: '4' }), SEL)
    expect(result).toEqual({ op: { kind: 'changeDuration', target: SEL, duration: 'quarter' } })
  })
})

describe('mapKey — chord verbs', () => {
  it('opens the chord palette on plain c', () => {
    expect(mapKey(ev({ key: 'c' }), undefined)).toEqual({ kind: 'toggleChordPalette' })
  })

  it('does NOT open the palette on Shift+c (reserved for pitch-stack)', () => {
    expect(mapKey(ev({ key: 'C', shiftKey: true }), SEL)).toBeNull()
  })

  it('does NOT open the palette on Ctrl/Cmd+c (system copy)', () => {
    expect(mapKey(ev({ key: 'c', ctrlKey: true }), SEL)).toBeNull()
    expect(mapKey(ev({ key: 'c', metaKey: true }), SEL)).toBeNull()
  })

  it('palette toggle works without a selection', () => {
    expect(mapKey(ev({ key: 'c' }), undefined)).toEqual({ kind: 'toggleChordPalette' })
  })
})

describe('pitchForStackKey', () => {
  const C4: Pitch = { step: 'C', octave: 4 }

  it('returns a step+octave for Shift+letter', () => {
    expect(pitchForStackKey(ev({ key: 'E', shiftKey: true }), C4)).toEqual({ step: 'E', octave: 4 })
    expect(pitchForStackKey(ev({ key: 'g', shiftKey: true }), C4)).toEqual({ step: 'G', octave: 4 })
  })

  it('returns undefined when Shift is not held', () => {
    expect(pitchForStackKey(ev({ key: 'E' }), C4)).toBeUndefined()
  })

  it('returns undefined for non-letter keys', () => {
    expect(pitchForStackKey(ev({ key: '1', shiftKey: true }), C4)).toBeUndefined()
    expect(pitchForStackKey(ev({ key: 'H', shiftKey: true }), C4)).toBeUndefined()
  })

  it('returns undefined when Shift is held but combined with Ctrl/Meta/Alt', () => {
    expect(pitchForStackKey(ev({ key: 'E', shiftKey: true, ctrlKey: true }), C4)).toBeUndefined()
    expect(pitchForStackKey(ev({ key: 'E', shiftKey: true, altKey: true }), C4)).toBeUndefined()
  })

  it('inherits the octave from the supplied top pitch', () => {
    const C5: Pitch = { step: 'C', octave: 5 }
    expect(pitchForStackKey(ev({ key: 'E', shiftKey: true }), C5)).toEqual({ step: 'E', octave: 5 })
  })

  it('falls back to octave 4 when top pitch is missing or rest', () => {
    expect(pitchForStackKey(ev({ key: 'F', shiftKey: true }), undefined)).toEqual({ step: 'F', octave: 4 })
    expect(pitchForStackKey(ev({ key: 'F', shiftKey: true }), { step: 'rest', octave: 4 })).toEqual({
      step: 'F', octave: 4,
    })
  })
})

describe('mapKey — bar-level structural shortcuts (M19-PR-5)', () => {
  it('plain Backspace deletes the EVENT (legacy behavior preserved)', () => {
    expect(mapKey(ev({ key: 'Backspace' }), SEL)).toEqual({
      op: { kind: 'deleteEvent', target: SEL },
    })
  })

  it('plain Delete deletes the EVENT (legacy behavior preserved)', () => {
    expect(mapKey(ev({ key: 'Delete' }), SEL)).toEqual({
      op: { kind: 'deleteEvent', target: SEL },
    })
  })

  it('Shift+Backspace routes the BAR to the always-confirm delete gate', () => {
    const sel: Selection = { measureIdx: 3, eventIdx: 1 }
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true }), sel)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 3,
      fromEnd: 3,
    })
  })

  it('Shift+Delete also routes the BAR to the delete gate (mirrors Shift+Backspace)', () => {
    const sel: Selection = { measureIdx: 2, eventIdx: 0 }
    expect(mapKey(ev({ key: 'Delete', shiftKey: true }), sel)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 2,
      fromEnd: 2,
    })
  })

  it('plain Delete/Backspace with ONLY a measure range routes to the delete gate', () => {
    // No per-event selection (Ctrl/Cmd-clicked a bar) → plain Delete
    // deletes the bar via the confirm gate.
    const range = { fromStart: 1, fromEnd: 1 }
    expect(mapKey(ev({ key: 'Backspace' }), undefined, range)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 1,
      fromEnd: 1,
    })
    expect(mapKey(ev({ key: 'Delete' }), undefined, range)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 1,
      fromEnd: 1,
    })
  })

  it('plain Delete with an event selected stays per-event even if a range is set', () => {
    // Granular intent wins: deleteEvent, NOT the measure-delete gate.
    const sel: Selection = { measureIdx: 0, eventIdx: 0 }
    const range = { fromStart: 0, fromEnd: 2 }
    expect(mapKey(ev({ key: 'Delete' }), sel, range)).toEqual({
      op: { kind: 'deleteEvent', target: sel },
    })
  })

  it('plain Delete with neither selection nor range is a no-op', () => {
    expect(mapKey(ev({ key: 'Delete' }), undefined, undefined)).toBeNull()
  })

  it('Shift+Cmd+Backspace is NOT bar-delete (falls through to legacy deleteEvent)', () => {
    // Cmd/Ctrl + Shift + Backspace doesn't match the bar-delete gate
    // (which requires shift only, no other modifier). It falls through
    // to the legacy plain-Backspace branch which is modifier-agnostic
    // and returns deleteEvent. Pinning current behavior — if a future
    // tightening rejects modifiers on plain Backspace too, update this.
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true, metaKey: true }), SEL)).toEqual({
      op: { kind: 'deleteEvent', target: SEL },
    })
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true, altKey: true }), SEL)).toEqual({
      op: { kind: 'deleteEvent', target: SEL },
    })
  })

  it('Cmd+D duplicates the BAR immediately after itself via dragMeasureRange', () => {
    const sel: Selection = { measureIdx: 4, eventIdx: 2 }
    expect(mapKey(ev({ key: 'd', metaKey: true }), sel)).toEqual({
      op: {
        kind: 'dragMeasureRange',
        mode: 'duplicate',
        fromStart: 4,
        fromEnd: 4,
        toAfter: 4,
      },
    })
  })

  it('Ctrl+D duplicates the BAR (Windows / Linux convention mirrors Cmd+D)', () => {
    const sel: Selection = { measureIdx: 1, eventIdx: 0 }
    expect(mapKey(ev({ key: 'D', ctrlKey: true }), sel)).toEqual({
      op: {
        kind: 'dragMeasureRange',
        mode: 'duplicate',
        fromStart: 1,
        fromEnd: 1,
        toAfter: 1,
      },
    })
  })

  it('Shift+Cmd+D is NOT bar-duplicate (modifier collision avoidance)', () => {
    // Common terminal gesture: Cmd+Shift+D = "split pane". Don't
    // shadow it. Bar-duplicate is strictly Cmd/Ctrl+D with no Shift
    // or Alt.
    expect(mapKey(ev({ key: 'D', metaKey: true, shiftKey: true }), SEL)).toBeNull()
    expect(mapKey(ev({ key: 'D', ctrlKey: true, shiftKey: true }), SEL)).toBeNull()
    expect(mapKey(ev({ key: 'd', metaKey: true, altKey: true }), SEL)).toBeNull()
  })

  it('Cmd+D returns null when there is no selection (no target bar)', () => {
    expect(mapKey(ev({ key: 'd', metaKey: true }), undefined)).toBeNull()
  })

  it('Shift+Backspace returns null when there is no selection', () => {
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true }), undefined)).toBeNull()
  })

  it('bar-delete on the only measure still routes to the gate (guard lives in the store)', () => {
    // mapKey is pure routing — it always emits the requestMeasureDelete
    // action. The "would empty the score" guard now lives in the
    // requestMeasureDelete store action (covered in
    // state.measureDelete.test.ts), which refuses + surfaces an error
    // instead of opening the modal.
    const sel: Selection = { measureIdx: 0, eventIdx: 0 }
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true }), sel)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 0,
      fromEnd: 0,
    })
  })

  it('Cmd+D uses the selection.measureIdx for both fromStart/fromEnd AND toAfter', () => {
    // Pins the "duplicate adjacent" semantic: the copy lands
    // immediately AFTER the source (toAfter = fromEnd → result is
    // [..., bar, COPY, ...]).
    const sel: Selection = { measureIdx: 5, eventIdx: 0 }
    const result = mapKey(ev({ key: 'd', metaKey: true }), sel)
    expect(result).toEqual({
      op: {
        kind: 'dragMeasureRange',
        mode: 'duplicate',
        fromStart: 5,
        fromEnd: 5,
        toAfter: 5,
      },
    })
  })
})

describe('mapKey — measureRangeSelection consumed (M19-PR-6)', () => {
  it('Shift+Backspace prefers measureRangeSelection over per-event selection', () => {
    // Per-event selection at measureIdx 0, but range covers 3..5.
    // Range wins — the delete gate targets the range.
    const sel: Selection = { measureIdx: 0, eventIdx: 0 }
    const range = { fromStart: 3, fromEnd: 5 }
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true }), sel, range)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 3,
      fromEnd: 5,
    })
  })

  it('Shift+Backspace works with ONLY a measureRangeSelection (no per-event selection)', () => {
    const range = { fromStart: 2, fromEnd: 4 }
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true }), undefined, range)).toEqual({
      kind: 'requestMeasureDelete',
      fromStart: 2,
      fromEnd: 4,
    })
  })

  it('Cmd+D over a range duplicates the WHOLE range with toAfter=fromEnd (adjacent)', () => {
    // Range 4..7, no per-event selection → duplicate 4 bars
    // immediately after bar 7. The copy lands at bars 8..11.
    const range = { fromStart: 4, fromEnd: 7 }
    expect(mapKey(ev({ key: 'd', metaKey: true }), undefined, range)).toEqual({
      op: {
        kind: 'dragMeasureRange',
        mode: 'duplicate',
        fromStart: 4,
        fromEnd: 7,
        toAfter: 7,
      },
    })
  })

  it('Cmd+D with both selection AND range: range wins', () => {
    const sel: Selection = { measureIdx: 0, eventIdx: 0 }
    const range = { fromStart: 2, fromEnd: 5 }
    expect(mapKey(ev({ key: 'd', metaKey: true }), sel, range)).toEqual({
      op: {
        kind: 'dragMeasureRange',
        mode: 'duplicate',
        fromStart: 2,
        fromEnd: 5,
        toAfter: 5,
      },
    })
  })

  it('Shift+Backspace returns null when NEITHER selection nor range is set', () => {
    expect(mapKey(ev({ key: 'Backspace', shiftKey: true }), undefined, undefined)).toBeNull()
  })

  it('Cmd+D returns null when NEITHER selection nor range is set', () => {
    expect(mapKey(ev({ key: 'd', metaKey: true }), undefined, undefined)).toBeNull()
  })

  it('single-bar range matches selection-only behavior (no regression for M19-PR-5)', () => {
    // Range {fromStart: 3, fromEnd: 3} should produce identical op to
    // selection { measureIdx: 3 }. Pins "M19-PR-5 fallback is a
    // special case of M19-PR-6".
    const range = { fromStart: 3, fromEnd: 3 }
    const sel: Selection = { measureIdx: 3, eventIdx: 0 }
    const fromRange = mapKey(ev({ key: 'Backspace', shiftKey: true }), undefined, range)
    const fromSel = mapKey(ev({ key: 'Backspace', shiftKey: true }), sel, undefined)
    expect(fromRange).toEqual(fromSel)
  })
})
