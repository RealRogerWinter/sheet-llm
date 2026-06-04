import type { Duration, Event, Measure, Meter } from './types'
import { meterCapacityIn32nds } from './meter'

/**
 * Measure-time arithmetic and rebalancing primitives, used by
 * transformScoreBalanced (Phase 2) to make every direct-manipulation
 * edit produce a measure-valid score (sum of event durations equals
 * meter capacity).
 *
 * Working unit: 32nd notes. Every allowed Duration and every allowed
 * meter denominator divides 32, so all arithmetic is integer-exact —
 * no epsilon comparisons, no floating-point drift across edits.
 *
 * The eighth-based duplicates in validateScore.ts and import/normalize.ts
 * are intentionally left in place; they predate this module and serve
 * the existing validator / anacrusis-padding paths. Consolidating them
 * is out of scope.
 */

/** 32nd-note units for each Duration. Integer-exact. */
export const DURATION_32NDS: Record<Duration, number> = {
  whole: 32,
  'dotted-half': 24,
  half: 16,
  'dotted-quarter': 12,
  quarter: 8,
  'dotted-eighth': 6,
  eighth: 4,
  sixteenth: 2,
  '32nd': 1,
}

/** Ordered largest-to-smallest for greedy decomposition. */
const DURATIONS_DESC: Duration[] = [
  'whole', 'dotted-half', 'half', 'dotted-quarter', 'quarter',
  'dotted-eighth', 'eighth', 'sixteenth', '32nd',
]

/** Default octave for synthesized rests. Musically meaningless (rests
 *  don't have pitch) but the schema requires an octave on every Pitch. */
const REST_OCTAVE = 4

/**
 * Maximum number of *additional* measures a tie-cascade may span
 * beyond the destination. depth=2 means a long note can occupy at
 * most three consecutive measures (destination + 2 more). Keeps a
 * pathological "drop a whole note at the last 32nd of a 1/32 bar"
 * from rippling across the entire score.
 */
export const MAX_CASCADE_DEPTH = 2

export type BalanceErrorCode =
  | 'tuplet_unsplittable'
  | 'tuplet_blocked'
  | 'cascade_overflow'
  | 'would_empty_measure'
  | 'unrepresentable'

export interface BalanceErrorDetails {
  measure?: number
  event?: number
  units?: number
}

export class BalanceError extends Error {
  readonly code: BalanceErrorCode
  readonly details?: BalanceErrorDetails

  constructor(message: string, code: BalanceErrorCode, details?: BalanceErrorDetails) {
    super(message)
    this.name = 'BalanceError'
    this.code = code
    this.details = details
  }
}

export function durationTo32nds(d: Duration): number {
  return DURATION_32NDS[d]
}

/**
 * Greedy largest-first decomposition of `units` (in 32nd-note units)
 * into a sequence of Duration enum values. The enum contains 1 (the
 * 32nd), so every positive integer decomposes successfully.
 *
 * CONTRACT (caller's responsibility):
 * - `units` must be a positive integer.
 * - Meter-blind: callers must ensure the resulting sequence fits
 *   within a single measure's capacity. For totals exceeding one
 *   measure, use `tieSplitOver`.
 *
 * Greedy isn't always *idiomatic* notation (beat-aware decomposition
 * is a Phase 5 follow-up), but the result is always a valid sequence
 * whose summed 32nd-units equal `units`.
 *
 * Throws BalanceError('unrepresentable') if `units` is not a positive
 * integer.
 */
export function decompose32nds(units: number): Duration[] {
  if (!Number.isInteger(units) || units <= 0) {
    throw new BalanceError(
      `decompose32nds: units must be a positive integer (got ${units})`,
      'unrepresentable',
      { units },
    )
  }
  const out: Duration[] = []
  let remaining = units
  for (const d of DURATIONS_DESC) {
    const v = DURATION_32NDS[d]
    while (remaining >= v) {
      out.push(d)
      remaining -= v
    }
  }
  // remaining must be 0 because the enum contains 1.
  return out
}

/**
 * Build a sequence of rest events totalling `units` 32nds. Metadata
 * (tuplet, ties, articulations, etc.) is intentionally absent — rests
 * synthesized by this function are "pure padding" with no carry-over
 * from any source event.
 */
export function fillWithRests(units: number, octave: number = REST_OCTAVE): Event[] {
  const durations = decompose32nds(units)
  return durations.map((d) => ({
    pitches: [{ step: 'rest', octave }],
    duration: d,
  }))
}

/**
 * Build a measure full of rests matching the meter's capacity. Use this
 * anywhere you'd otherwise hard-code `duration:'whole'` for an empty
 * bar — that only sums correctly in 4/4 / C and fails the
 * measure-duration invariant in 3/4, 6/8, 5/4, etc.
 */
export function fillMeasureWithRests(meter: Meter, octave: number = REST_OCTAVE): Measure {
  return { events: fillWithRests(meterCapacityIn32nds(meter), octave) }
}

function clonePitches(event: Event): Event['pitches'] {
  return event.pitches.map((p) => ({ ...p }))
}

/**
 * Build one event in a tied chain. Each call returns a fresh Event
 * with a freshly-cloned pitches array — no aliasing between sibling
 * parts. `isFirstEvent` carries source articulation/ornament/dynamic;
 * `isLastEvent` preserves the source's trailing tie. All other emitted
 * events get `tied_to_next: true` to chain them.
 */
function decoratePart(
  source: Event,
  d: Duration,
  partIdx: number,
  durIdx: number,
  lastPartIdx: number,
  durationsInLastPart: number,
): Event {
  const isFirstEvent = partIdx === 0 && durIdx === 0
  const isLastEvent = partIdx === lastPartIdx && durIdx === durationsInLastPart - 1
  const e: Event = {
    pitches: clonePitches(source),
    duration: d,
  }
  if (!isLastEvent) {
    e.tied_to_next = true
  } else if (source.tied_to_next) {
    e.tied_to_next = true
  }
  if (isFirstEvent) {
    if (source.articulation) e.articulation = source.articulation
    if (source.ornament) e.ornament = source.ornament
    if (source.dynamic) e.dynamic = source.dynamic
  }
  return e
}

/**
 * Split an event into a flat tied sequence whose per-part 32nd-totals
 * match `parts32nds`. Each part may itself decompose into multiple
 * events (e.g., a 7-unit part → dotted-eighth + 32nd, both tied). All
 * but the last emitted event get `tied_to_next: true`; the last
 * preserves the original's `tied_to_next` so an already-tied chain
 * stays linked to its successor.
 *
 * EDITORIAL: articulation / ornament / dynamic carry only on the first
 * emitted event — these are attack/decay marks that don't carry across
 * the sustain of a tied chain.
 *
 * Throws BalanceError('tuplet_unsplittable') for tuplet events
 * (tuplets cannot cross barlines in this schema).
 * Throws BalanceError('unrepresentable') if the parts don't sum to the
 * event's duration in 32nds.
 */
export function tieSplitEvent(event: Event, parts32nds: number[]): Event[] {
  if (event.tuplet !== undefined) {
    throw new BalanceError(
      'Cannot split a tuplet event across barlines',
      'tuplet_unsplittable',
    )
  }
  if (parts32nds.length === 0) return []
  for (const p of parts32nds) {
    if (!Number.isInteger(p) || p <= 0) {
      throw new BalanceError(
        `tieSplitEvent: every part must be a positive integer (got ${p})`,
        'unrepresentable',
        { units: p },
      )
    }
  }
  const totalRequested = parts32nds.reduce((a, b) => a + b, 0)
  const eventUnits = DURATION_32NDS[event.duration]
  if (totalRequested !== eventUnits) {
    throw new BalanceError(
      `tieSplitEvent: parts sum to ${totalRequested} 32nds, expected ${eventUnits}`,
      'unrepresentable',
      { units: totalRequested },
    )
  }
  // No length-1 short-circuit: even a single part may decompose into
  // multiple durations (e.g. [7] → dotted-eighth + 32nd, both tied).
  // The unified loop also ensures articulation/ornament/dynamic and
  // source.tied_to_next are preserved in the single-part case.
  const lastPartIdx = parts32nds.length - 1
  const lastPartDurations = decompose32nds(parts32nds[lastPartIdx])
  const out: Event[] = []
  parts32nds.forEach((units, partIdx) => {
    const durations = decompose32nds(units)
    durations.forEach((d, durIdx) => {
      out.push(decoratePart(event, d, partIdx, durIdx, lastPartIdx, lastPartDurations.length))
    })
  })
  return out
}

/**
 * Split an event whose duration exceeds a single measure's capacity
 * into per-measure tied event arrays. `firstMeasureRoom` is the
 * available 32nd-units in the destination measure; `capacityUnits` is
 * the meter capacity used for each subsequent (fresh) measure.
 *
 * Returns one array per measure: `out[0]` for the destination,
 * `out[1..]` for cascading "next" measures. If the event fits entirely
 * in the destination, returns `[[event]]` (single per-measure group);
 * source articulation/ornament/dynamic and `tied_to_next` are preserved.
 *
 * Caps at MAX_CASCADE_DEPTH additional measures — throws
 * BalanceError('cascade_overflow') if more would be required.
 *
 * Throws BalanceError('tuplet_unsplittable') for tuplet events.
 * Throws BalanceError('cascade_overflow') if `firstMeasureRoom <= 0`.
 */
export function tieSplitOver(
  event: Event,
  firstMeasureRoom: number,
  capacityUnits: number,
): Event[][] {
  if (event.tuplet !== undefined) {
    throw new BalanceError(
      'Cannot split a tuplet event across barlines',
      'tuplet_unsplittable',
    )
  }
  if (firstMeasureRoom <= 0) {
    throw new BalanceError(
      'No room in destination measure to start a cascade',
      'cascade_overflow',
      { units: firstMeasureRoom },
    )
  }
  if (capacityUnits <= 0) {
    throw new BalanceError(
      'Invalid measure capacity for cascade',
      'cascade_overflow',
      { units: capacityUnits },
    )
  }
  const totalUnits = DURATION_32NDS[event.duration]
  const parts: number[] = []
  if (totalUnits <= firstMeasureRoom) {
    parts.push(totalUnits)
  } else {
    parts.push(firstMeasureRoom)
    let remaining = totalUnits - firstMeasureRoom
    let extraMeasures = 0
    while (remaining > 0) {
      extraMeasures++
      if (extraMeasures > MAX_CASCADE_DEPTH) {
        throw new BalanceError(
          `Cascade would span ${extraMeasures + 1} measures (limit is ${MAX_CASCADE_DEPTH + 1})`,
          'cascade_overflow',
          { units: totalUnits },
        )
      }
      const take = Math.min(remaining, capacityUnits)
      parts.push(take)
      remaining -= take
    }
  }
  // Unified per-measure decoration: even the fits-in-destination case
  // (parts.length === 1) goes through decoratePart so source metadata
  // is preserved consistently.
  const lastPartIdx = parts.length - 1
  const lastPartDurations = decompose32nds(parts[lastPartIdx])
  const out: Event[][] = []
  parts.forEach((partUnits, partIdx) => {
    const durations = decompose32nds(partUnits)
    const partEvents = durations.map((d, durIdx) =>
      decoratePart(event, d, partIdx, durIdx, lastPartIdx, lastPartDurations.length),
    )
    out.push(partEvents)
  })
  return out
}

export interface ConsumeResult {
  /** Events remaining after consumption. */
  remaining: Event[]
  /** Events that were removed, in the order they appeared in the input. */
  consumed: Event[]
  /** Total 32nds removed. Zero if `blocked`. */
  consumedUnits: number
  /** Overshoot: removed more than requested (caller should fill with a rest). */
  leftoverUnits: number
  /** Undershoot: ran out of events before reaching `units` (caller may cascade). */
  shortfallUnits: number
  /** Set if consumption was refused because it would partially eat a tuplet group. */
  blocked?: 'tuplet'
}

/**
 * Greedily remove events from one end of `events` until at least
 * `units` 32nds have been removed.
 *
 * - `side: 'front'` removes from index 0 onwards (the start of the
 *   measure — used when a note is dropped at the *beginning* of a
 *   measure).
 * - `side: 'back'` removes from the end (used for drops at the *end*).
 *
 * Tuplets are atomic: if the next event to consume would be a tuplet
 * member, consumption is refused entirely (returns the unchanged
 * input with `blocked: 'tuplet'`). Callers should surface a "can't
 * drop onto a tuplet" affordance.
 *
 * `units <= 0` is a no-op.
 */
export function consumeForRoom(
  events: Event[],
  side: 'front' | 'back',
  units: number,
): ConsumeResult {
  if (units <= 0) {
    return {
      remaining: events,
      consumed: [],
      consumedUnits: 0,
      leftoverUnits: 0,
      shortfallUnits: 0,
    }
  }
  const order = side === 'front'
    ? events.map((_, i) => i)
    : events.map((_, i) => events.length - 1 - i)
  const consumedIdx = new Set<number>()
  let consumedUnits = 0
  let blocked: 'tuplet' | undefined
  for (const i of order) {
    if (consumedUnits >= units) break
    const ev = events[i]
    if (ev.tuplet !== undefined) {
      blocked = 'tuplet'
      break
    }
    consumedIdx.add(i)
    consumedUnits += DURATION_32NDS[ev.duration]
  }
  if (blocked) {
    return {
      remaining: events,
      consumed: [],
      consumedUnits: 0,
      leftoverUnits: 0,
      shortfallUnits: units,
      blocked,
    }
  }
  const remaining = events.filter((_, i) => !consumedIdx.has(i))
  const consumed = events.filter((_, i) => consumedIdx.has(i))
  const leftover = Math.max(0, consumedUnits - units)
  const shortfall = Math.max(0, units - consumedUnits)
  return {
    remaining,
    consumed,
    consumedUnits,
    leftoverUnits: leftover,
    shortfallUnits: shortfall,
  }
}

export function isRest(ev: Event): boolean {
  return ev.pitches.length === 1 && ev.pitches[0].step === 'rest'
}

function unitsToSingleDuration(units: number): Duration | undefined {
  for (const d of DURATIONS_DESC) {
    if (DURATION_32NDS[d] === units) return d
  }
  return undefined
}

/**
 * Combine consecutive rest events when the summed duration is
 * representable as a single Duration enum value. Conservative:
 * - Refuses to merge across tuplet boundaries (either event having
 *   `tuplet` set).
 * - Refuses to merge if either event has `tied_to_next` (avoids
 *   silently losing a tie).
 * - Merges only adjacent pairs; chains of three or more collapse
 *   incrementally as the scan proceeds.
 *
 * Non-representable sums (e.g. dotted-eighth + eighth = 10 units) are
 * left unmerged. A future beat-aware pass could re-group these.
 *
 * MERGE METADATA POLICY: the merged event keeps the FIRST rest's
 * pitches (and thus octave), articulation, ornament, and dynamic.
 * The second rest's optional metadata is dropped. Articulations and
 * dynamics on rests are musically unusual but schema-permitted; if
 * callers attach them, they should expect first-wins semantics.
 */
export function mergeAdjacentRests(events: Event[]): Event[] {
  const out: Event[] = []
  for (const ev of events) {
    const prev = out[out.length - 1]
    if (
      prev &&
      isRest(ev) &&
      isRest(prev) &&
      prev.tuplet === undefined &&
      ev.tuplet === undefined &&
      !prev.tied_to_next &&
      !ev.tied_to_next
    ) {
      const sum = DURATION_32NDS[prev.duration] + DURATION_32NDS[ev.duration]
      const merged = unitsToSingleDuration(sum)
      if (merged) {
        out[out.length - 1] = { ...prev, duration: merged }
        continue
      }
    }
    out.push(ev)
  }
  return out
}
