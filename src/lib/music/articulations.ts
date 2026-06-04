import type { Articulation, Event } from './types'

/**
 * Canonical stacking order: staccato is innermost (closest to the
 * notehead); each successive glyph stacks further out. Used by
 * normalizeArticulations to sort an unordered input array.
 *
 * Source: Gould, Behind Bars, pp. 113-117.
 */
const STACKING_ORDER: Record<Articulation, number> = {
  staccato: 0,
  portato: 1,
  tenuto: 2,
  accent: 3,
  marcato: 4,
  none: 99,
}

/**
 * Returns the unified articulation array for an event, honoring both
 * the legacy `articulation` (singular) and new `articulations`
 * (plural) fields. The new field takes precedence; the legacy field
 * is wrapped into a single-element array when present.
 *
 * 'none' entries are filtered out.
 */
export function getArticulations(event: Pick<Event, 'articulation' | 'articulations'>): Articulation[] {
  if (event.articulations && event.articulations.length > 0) {
    return event.articulations.filter((a) => a !== 'none')
  }
  if (event.articulation && event.articulation !== 'none') {
    return [event.articulation]
  }
  return []
}

/** True if the event has the given articulation applied. */
export function hasArticulation(
  event: Pick<Event, 'articulation' | 'articulations'>,
  art: Articulation,
): boolean {
  return getArticulations(event).includes(art)
}

/**
 * Normalize an articulation list: sort in canonical stacking order,
 * deduplicate, coerce staccato+tenuto → portato (single glyph), and
 * reject marcato+accent combinations.
 *
 * Returns the normalized array. Throws ArticulationStackingError if
 * the input combines marcato and accent — that's a notational
 * incoherence the caller should surface to the user, not paper over.
 */
export function normalizeArticulations(input: Articulation[]): Articulation[] {
  const set = new Set<Articulation>(input.filter((a) => a !== 'none'))

  if (set.has('marcato') && set.has('accent')) {
    throw new ArticulationStackingError(
      "marcato + accent on the same note is incoherent — pick one",
    )
  }

  // staccato + tenuto → portato (single glyph). Apply unless portato
  // is already present.
  if (set.has('staccato') && set.has('tenuto') && !set.has('portato')) {
    set.delete('staccato')
    set.delete('tenuto')
    set.add('portato')
  }

  return Array.from(set).sort((a, b) => STACKING_ORDER[a] - STACKING_ORDER[b])
}

/**
 * Returns a new Event with `art` added to its articulations.
 * Normalizes the result (canonical order, portato coercion, marcato/
 * accent rejection). Pure / immutable.
 */
export function withArticulation(event: Event, art: Articulation): Event {
  if (art === 'none') return event
  const current = getArticulations(event)
  const updated = normalizeArticulations([...current, art])
  // Strip the legacy singular field once we've moved to the array
  // representation so getArticulations() doesn't double-count.
  const { articulation: _legacy, ...rest } = event
  void _legacy
  return { ...rest, articulations: updated }
}

/**
 * Returns a new Event with `art` removed from its articulations.
 */
export function withoutArticulation(event: Event, art: Articulation): Event {
  const current = getArticulations(event)
  const updated = current.filter((a) => a !== art)
  const { articulation: _legacy, ...rest } = event
  void _legacy
  if (updated.length === 0) {
    // Drop the field entirely when emptied.
    const { articulations: _arts, ...stripped } = rest
    void _arts
    return stripped
  }
  return { ...rest, articulations: updated }
}

export class ArticulationStackingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArticulationStackingError'
  }
}
