import type { Event, Pitch } from './types'

/**
 * Returns true if the given pitch in an event ties to the
 * corresponding pitch in the next event.
 *
 * Semantics — both representations are consulted, with per-pitch
 * taking precedence:
 *
 *   1. If `pitch.tied_to_next === true`, the pitch is tied.
 *   2. If `pitch.tied_to_next === false`, the pitch is explicitly
 *      not tied even if the legacy event-wide flag is on.
 *   3. Otherwise, fall back to `event.tied_to_next` (legacy
 *      whole-event tie). All pitches in the event share the flag.
 *
 * This lets PR-3 ship per-pitch ties without breaking the existing
 * event-wide model. PR-12 migration normalizes event-wide ties into
 * per-pitch ties and removes the legacy field.
 */
export function isPitchTiedToNext(
  pitch: Pick<Pitch, 'tied_to_next'>,
  event: Pick<Event, 'tied_to_next'>,
): boolean {
  if (pitch.tied_to_next === true) return true
  if (pitch.tied_to_next === false) return false
  return event.tied_to_next === true
}

/**
 * Returns true if a pitch is marked laissez vibrer (open-ended tie,
 * no target required). Common on harp, vibraphone, sustained piano.
 */
export function isLaissezVibrer(pitch: Pick<Pitch, 'lv'>): boolean {
  return pitch.lv === true
}

/**
 * Returns true if the tie out of this pitch should permit an
 * enharmonic respell in the next event (e.g., C#→Db).
 */
export function isEnharmonicTie(pitch: Pick<Pitch, 'enharmonicTie'>): boolean {
  return pitch.enharmonicTie === true
}

/**
 * Returns the indices of pitches in `event` that are tied to the
 * next event. Honors per-pitch flags first and falls back to the
 * legacy event-wide flag.
 */
export function tiedPitchIndices(event: Event): number[] {
  const out: number[] = []
  event.pitches.forEach((p, i) => {
    if (isPitchTiedToNext(p, event)) out.push(i)
  })
  return out
}

/**
 * Returns a new Pitch object with `tied_to_next` set as requested.
 * Pure / immutable; the input is not mutated.
 */
export function withPitchTie(pitch: Pitch, tied: boolean): Pitch {
  return { ...pitch, tied_to_next: tied }
}

/**
 * Returns a new Pitch with `lv` set. Pure / immutable.
 */
export function withLaissezVibrer(pitch: Pitch, lv: boolean): Pitch {
  return { ...pitch, lv }
}
