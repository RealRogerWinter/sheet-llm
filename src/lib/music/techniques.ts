import { nanoid } from 'nanoid'
import type { Score, TechniqueChange, TechniqueKind } from './types'

const ID_LENGTH = 10

/** Pairs of technique kinds where the second cancels the first. */
const CANCEL_PAIRS: Record<TechniqueKind, TechniqueKind | undefined> = {
  pizz: 'arco',
  arco: 'pizz',
  'col-legno-battuto': 'arco',
  'col-legno-tratto': 'arco',
  'sul-ponticello': 'ord',
  'sul-tasto': 'ord',
  flautando: 'ord',
  ord: undefined, // ord cancels several; the inverse isn't well-defined.
  'snap-pizz': 'arco',
  'LH-pizz': 'arco',
  tremolo: 'ord',
  'mute-on': 'mute-off',
  'mute-off': 'mute-on',
}

/** Fresh ID for a new technique change. */
export function createTechniqueId(): string {
  return nanoid(ID_LENGTH)
}

/**
 * Construct a new TechniqueChange with a fresh id.
 */
export function createTechniqueChange(
  measureIdx: number,
  staffIdx: number,
  voiceIdx: number,
  kind: TechniqueKind,
  eventIdx?: number,
): TechniqueChange {
  return {
    id: createTechniqueId(),
    measureIdx,
    staffIdx,
    voiceIdx,
    kind,
    ...(eventIdx !== undefined ? { eventIdx } : {}),
  }
}

/**
 * Returns the active technique on the given voice at the given
 * (measureIdx, eventIdx), or undefined if no technique is in effect.
 *
 * Walks every technique change on that voice, ordered by (measureIdx,
 * eventIdx), and tracks the latest change at-or-before the query
 * position. Cancellation semantics: when a 'arco' (or other cancel)
 * marker is at-or-before the query, the previously-active technique
 * is undone, so the result is undefined until another non-cancel
 * marker takes effect.
 */
export function activeTechniqueAt(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx?: number,
): TechniqueKind | undefined {
  if (!score.techniqueStates || score.techniqueStates.length === 0) {
    return undefined
  }

  // Filter to this voice, then sort by position.
  const relevant = score.techniqueStates
    .filter((t) => t.staffIdx === staffIdx && t.voiceIdx === voiceIdx)
    .sort((a, b) => {
      if (a.measureIdx !== b.measureIdx) return a.measureIdx - b.measureIdx
      return (a.eventIdx ?? 0) - (b.eventIdx ?? 0)
    })

  let active: TechniqueKind | undefined
  for (const t of relevant) {
    if (isAfter(t, measureIdx, eventIdx)) break
    // 'arco', 'ord', 'mute-off' don't establish a positive technique
    // when they're cancelling a prior one; instead they clear active.
    if (active && CANCEL_PAIRS[active] === t.kind) {
      active = undefined
    } else if (t.kind === 'arco' || t.kind === 'ord' || t.kind === 'mute-off') {
      // Pure-cancel markers without a matching prior do nothing.
      active = undefined
    } else {
      active = t.kind
    }
  }
  return active
}

function isAfter(t: TechniqueChange, measureIdx: number, eventIdx?: number): boolean {
  if (t.measureIdx > measureIdx) return true
  if (t.measureIdx < measureIdx) return false
  if (eventIdx === undefined) return false
  const tev = t.eventIdx ?? 0
  return tev > eventIdx
}

/**
 * Returns all technique changes on the given voice in playback
 * order. Useful for rendering the technique track.
 */
export function techniquesOnVoice(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
): TechniqueChange[] {
  if (!score.techniqueStates) return []
  return score.techniqueStates
    .filter((t) => t.staffIdx === staffIdx && t.voiceIdx === voiceIdx)
    .sort((a, b) => {
      if (a.measureIdx !== b.measureIdx) return a.measureIdx - b.measureIdx
      return (a.eventIdx ?? 0) - (b.eventIdx ?? 0)
    })
}

/**
 * Returns every technique change placed AT this exact (staffIdx,
 * voiceIdx, measureIdx, eventIdx) tuple. A change with `eventIdx`
 * omitted is treated as positioned at event 0 of its measure.
 *
 * Used by the editor popover to surface "what markers live at the
 * selected note" and to compute remove-by-id targets when the user
 * clicks an already-active technique button.
 *
 * Usually returns 0 or 1 entry. Multiple entries at the same position
 * are legal (e.g. "mute-off" + "pizz" on the same downbeat as one
 * passage ends and another begins); both come back in input order.
 */
export function techniquesAtPosition(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): TechniqueChange[] {
  if (!score.techniqueStates) return []
  return score.techniqueStates.filter(
    (t) =>
      t.staffIdx === staffIdx &&
      t.voiceIdx === voiceIdx &&
      t.measureIdx === measureIdx &&
      (t.eventIdx ?? 0) === eventIdx,
  )
}

/**
 * Walk a Score-shaped input and assign ids to every TechniqueChange
 * that lacks one. Existing ids (length 8..16) are preserved; out-of-
 * bound ids are replaced. Tolerates unknown input so it can be called
 * before zod parsing. Mutates in place AND returns for chaining.
 *
 * LLM-authored render_score calls may omit the id field on technique
 * states; call this on the parsed score before any edit-op or
 * deletion path that resolves a change by its id.
 */
export function ensureTechniqueIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const states = score.techniqueStates
  if (!Array.isArray(states)) return input
  for (const change of states) {
    if (!change || typeof change !== 'object') continue
    const c = change as Record<string, unknown>
    if (
      typeof c.id === 'string' &&
      c.id.length >= 8 &&
      c.id.length <= 16
    ) {
      continue
    }
    c.id = createTechniqueId()
  }
  return input
}
