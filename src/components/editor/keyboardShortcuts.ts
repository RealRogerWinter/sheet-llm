import type { Operation } from '@/lib/music/editOperations'
import type {
  ActiveAccidental,
  BaseDuration,
  MeasureRangeSelection,
  Selection,
} from '@/lib/chat/state'
import type { Accidental, Duration, Pitch, Step } from '@/lib/music/types'

export type StoreAction =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'toggleCheatSheet' }
  | { kind: 'toggleChordPalette' }
  | { kind: 'clearSelection' }
  | { kind: 'setActiveDuration'; duration: BaseDuration }
  | { kind: 'toggleActiveDotted' }
  | { kind: 'setActiveAccidental'; accidental: ActiveAccidental }
  | { kind: 'requestMeasureDelete'; fromStart: number; fromEnd: number }

export type ShortcutResult = { op: Operation; coalesce?: string } | StoreAction | null

const STACK_LETTERS: Record<string, Step> = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G',
}

/**
 * Resolve a Shift+letter keystroke into a Pitch ready for
 * addPitchToChord. The new pitch inherits the octave of the
 * currently-selected pitch (closest match in the chord). When
 * there is no selection, returns undefined.
 */
export function pitchForStackKey(
  event: KeyboardEvent,
  topPitch: Pitch | undefined,
): Pitch | undefined {
  if (!event.shiftKey) return undefined
  // event.key is the upper-cased letter when Shift is held.
  const letter = event.key.toLowerCase()
  const step = STACK_LETTERS[letter]
  if (!step) return undefined
  // Modifier-only events also fire keydown for Shift itself — skip.
  if (event.key === 'Shift') return undefined
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined
  const octave = topPitch && topPitch.step !== 'rest' ? topPitch.octave : 4
  return { step, octave }
}

const DURATION_BY_KEY: Record<string, Duration> = {
  '1': '32nd',
  '2': 'sixteenth',
  '3': 'eighth',
  '4': 'quarter',
  '5': 'half',
  '6': 'whole',
}

// BaseDuration variant of the same map — used when there's no selection
// to set the picker's active duration (DURATION_BY_KEY's values are
// all base durations, but this typed alias avoids a wider cast at the
// call site).
const BASE_DURATION_BY_KEY: Record<string, BaseDuration> = {
  '1': '32nd',
  '2': 'sixteenth',
  '3': 'eighth',
  '4': 'quarter',
  '5': 'half',
  '6': 'whole',
}

const ACCIDENTAL_BY_KEY: Record<string, Accidental> = {
  '=': 'sharp',
  '-': 'flat',
  '0': 'natural',
}

const ACTIVE_ACCIDENTAL_BY_KEY: Record<string, ActiveAccidental> = {
  '=': 'sharp',
  '-': 'flat',
  '0': 'natural',
}

/**
 * Compute the inclusive measure range that bar-level shortcuts
 * (Shift+Backspace, Cmd/Ctrl+D) should act on (M19-PR-6).
 *
 * Precedence:
 *   1. If `measureRangeSelection` is set, use it (the user explicitly
 *      Cmd/Ctrl+clicked a measure to set a range).
 *   2. Else if `selection` is set, collapse to the per-event
 *      selection's measureIdx as a single-bar range (M19-PR-5
 *      fallback).
 *   3. Else return undefined — no bar to act on.
 *
 * Returns the {fromStart, fromEnd} shape the dragMeasureRange op
 * variants take so the caller can spread it directly.
 */
function resolveBarTarget(
  selection: Selection | undefined,
  measureRangeSelection: MeasureRangeSelection | undefined,
): MeasureRangeSelection | undefined {
  if (measureRangeSelection) return measureRangeSelection
  if (selection) {
    return { fromStart: selection.measureIdx, fromEnd: selection.measureIdx }
  }
  return undefined
}

/**
 * Map a keyboard event to an Operation or store action.
 * Returns null when the event is not a recognized shortcut.
 *
 * Pure — no side effects. Caller invokes the result via the store.
 */
export function mapKey(
  event: KeyboardEvent,
  selection: Selection | undefined,
  measureRangeSelection?: MeasureRangeSelection | undefined,
): ShortcutResult {
  // Undo / Redo
  const ctrl = event.ctrlKey || event.metaKey
  if (ctrl && event.key.toLowerCase() === 'z') {
    return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
  }
  if (ctrl && event.key.toLowerCase() === 'y') {
    return { kind: 'redo' }
  }

  // Cheat sheet toggle.
  if (event.key === '?' || (event.shiftKey && event.key === '/')) {
    return { kind: 'toggleCheatSheet' }
  }

  // Clear selection.
  if (event.key === 'Escape') {
    return { kind: 'clearSelection' }
  }

  // Open chord palette (c). Only when nothing else captures it —
  // skip if Shift/Ctrl/Meta/Alt are held (Shift+C is the stack-pitch
  // verb; Ctrl/Cmd+C is a system copy).
  if (
    event.key === 'c' &&
    !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  ) {
    return { kind: 'toggleChordPalette' }
  }

  // Bar-level structural shortcuts (M19-PR-5 + M19-PR-6 range
  // upgrade). Run BEFORE the no-selection guard because a measure
  // range may be set without a per-event selection (M19-PR-6 click
  // pattern: Cmd/Ctrl+click a bar to select it without picking an
  // event). Range wins over selection.measureIdx when both are set.
  const barTarget = resolveBarTarget(selection, measureRangeSelection)
  if (barTarget) {
    // Measure deletion ALWAYS routes through the confirm gate
    // (requestMeasureDelete → MeasureDeleteConfirmModal), never a direct
    // op. This keeps every keyboard path aligned with the floating-menu
    // 🗑 button + ⌘K command, so a stray keystroke can't nuke a bar
    // without a confirmation. The empty-score guard lives in the store
    // action, not here.
    const isDeleteKey = event.key === 'Delete' || event.key === 'Backspace'
    const noHardMods = !(event.ctrlKey || event.metaKey || event.altKey)
    // Shift+Delete/Backspace → confirm-delete the bar(s), whether the
    // target is a measure range or the selected event's own bar.
    if (isDeleteKey && event.shiftKey && noHardMods) {
      return { kind: 'requestMeasureDelete', fromStart: barTarget.fromStart, fromEnd: barTarget.fromEnd }
    }
    // Plain Delete/Backspace with a measure range but NO per-event
    // selection → confirm-delete the bar(s). When an event IS selected,
    // this falls through to per-event deletion below (granular wins).
    if (isDeleteKey && !event.shiftKey && noHardMods && !selection) {
      return { kind: 'requestMeasureDelete', fromStart: barTarget.fromStart, fromEnd: barTarget.fromEnd }
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'd'
    ) {
      return {
        op: {
          kind: 'dragMeasureRange',
          mode: 'duplicate',
          fromStart: barTarget.fromStart,
          fromEnd: barTarget.fromEnd,
          toAfter: barTarget.fromEnd,
        },
      }
    }
  }

  if (!selection) {
    // No selection — numeric/accidental/dot keys steer the click-to-place
    // picker so the next placed note inherits these settings.
    if (BASE_DURATION_BY_KEY[event.key]) {
      return { kind: 'setActiveDuration', duration: BASE_DURATION_BY_KEY[event.key] }
    }
    if (ACTIVE_ACCIDENTAL_BY_KEY[event.key]) {
      return { kind: 'setActiveAccidental', accidental: ACTIVE_ACCIDENTAL_BY_KEY[event.key] }
    }
    if (event.key === '.') {
      return { kind: 'toggleActiveDotted' }
    }
    return null
  }

  // Pitch nudges
  if (event.key === 'ArrowUp') {
    return event.shiftKey
      ? { op: { kind: 'changePitch', target: selection, deltaOctave: 1 }, coalesce: `pitch:${selection.measureIdx}:${selection.eventIdx}` }
      : { op: { kind: 'changePitch', target: selection, deltaStep: 1 }, coalesce: `pitch:${selection.measureIdx}:${selection.eventIdx}` }
  }
  if (event.key === 'ArrowDown') {
    return event.shiftKey
      ? { op: { kind: 'changePitch', target: selection, deltaOctave: -1 }, coalesce: `pitch:${selection.measureIdx}:${selection.eventIdx}` }
      : { op: { kind: 'changePitch', target: selection, deltaStep: -1 }, coalesce: `pitch:${selection.measureIdx}:${selection.eventIdx}` }
  }

  // Duration changes (1-6)
  if (DURATION_BY_KEY[event.key]) {
    return { op: { kind: 'changeDuration', target: selection, duration: DURATION_BY_KEY[event.key] } }
  }

  // Accidentals
  if (ACCIDENTAL_BY_KEY[event.key]) {
    return { op: { kind: 'setAccidental', target: selection, accidental: ACCIDENTAL_BY_KEY[event.key] } }
  }

  // (Bar-level Shift+Backspace + Cmd/Ctrl+D handled earlier via
  // resolveBarTarget, supporting both the per-event-selection
  // fallback and the M19-PR-6 measure range.)

  // Delete (plain — single event)
  if (event.key === 'Delete' || event.key === 'Backspace') {
    return { op: { kind: 'deleteEvent', target: selection } }
  }

  return null
}
