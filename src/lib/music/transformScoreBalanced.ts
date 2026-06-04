import type { Duration, Event, Measure, Score } from './types'
import { meterCapacityIn32nds } from './meter'
import {
  BalanceError,
  DURATION_32NDS,
  consumeForRoom,
  fillWithRests,
  mergeAdjacentRests,
  tieSplitOver,
} from './measureBalance'
import { getVoiceMeasures, withVoiceMeasures } from './scoreAccessors'

/**
 * Higher-level "balanced" edit operations. Every operation in this
 * module returns a Score whose measure totals match the meter — no
 * 5-quarters-in-4/4 surprises. Implemented as a thin layer over
 * editOperations.transformScore so the raw primitive stays available
 * for orchestrator and tests.
 *
 * Multi-staff / multi-voice: a BalancedTarget addresses `(staffIdx,
 * voiceIdx, measureIdx, eventIdx)`. Default voiceIdx is 0 to match
 * what the current Operation type supports; extra-voice edits are out
 * of scope for v1.
 *
 * On any failure that prevents a clean balanced result, throws a
 * `BalanceError` (from measureBalance) with a discriminated `code`
 * suitable for UX toasts:
 *   - 'tuplet_blocked'      — would orphan or partially consume a tuplet
 *   - 'tuplet_unsplittable' — moved event itself is a tuplet member
 *   - 'cascade_overflow'    — note too big for remaining measures
 *   - 'would_empty_measure' — last event being moved out
 *   - 'unrepresentable'     — indices out of range, drop position invalid
 */

export interface BalancedTarget {
  staffIdx?: number
  voiceIdx?: number
  measureIdx: number
  eventIdx: number
}

export type BalancedOp =
  | {
      kind: 'reorderBalanced'
      selection: BalancedTarget
      target: { measureIdx: number; position32nds: number }
    }
  | { kind: 'changeDurationBalanced'; selection: BalancedTarget; duration: Duration }
  | { kind: 'removeBalanced'; selection: BalancedTarget }

export function transformScoreBalanced(score: Score, op: BalancedOp): Score {
  switch (op.kind) {
    case 'reorderBalanced':
      return reorderBalanced(score, op)
    case 'changeDurationBalanced':
      return changeDurationBalanced(score, op)
    case 'removeBalanced':
      return removeBalanced(score, op)
  }
}

// ── shared helpers ───────────────────────────────────────────────────

function staffOf(t: BalancedTarget): number {
  return t.staffIdx ?? 0
}

function voiceOf(t: BalancedTarget): number {
  return t.voiceIdx ?? 0
}

function sumUnits(events: readonly Event[]): number {
  return events.reduce((s, e) => s + DURATION_32NDS[e.duration], 0)
}

/**
 * Cumulative 32nd offsets at each event boundary in a measure.
 * For events [e0, e1, e2] returns [0, dur(e0), dur(e0)+dur(e1), total].
 */
function eventBoundaries(events: readonly Event[]): number[] {
  const out: number[] = [0]
  let acc = 0
  for (const e of events) {
    acc += DURATION_32NDS[e.duration]
    out.push(acc)
  }
  return out
}

/**
 * Snap a 32nd-unit position to the nearest event-boundary index in
 * a measure. Returns the eventIdx BEFORE which to insert (0 for front,
 * events.length for end-append).
 */
function snapInsertionIdx(events: readonly Event[], position: number): number {
  const boundaries = eventBoundaries(events)
  let best = 0
  let bestDiff = Math.abs(boundaries[0] - position)
  for (let i = 1; i < boundaries.length; i++) {
    const d = Math.abs(boundaries[i] - position)
    if (d < bestDiff) {
      bestDiff = d
      best = i
    }
  }
  return best
}

/**
 * Detect a snap point that would fall INSIDE a tuplet group (between
 * two adjacent events that share a tuplet value). Splitting at such a
 * point would orphan the group and break validateMeasureTuplets.
 */
function insertionWouldSplitTuplet(events: readonly Event[], insertIdx: number): boolean {
  if (insertIdx <= 0 || insertIdx >= events.length) return false
  const prev = events[insertIdx - 1]
  const next = events[insertIdx]
  return prev.tuplet !== undefined && prev.tuplet === next.tuplet
}

function cloneEvent(event: Event): Event {
  const out: Event = {
    pitches: event.pitches.map((p) => ({ ...p })),
    duration: event.duration,
  }
  if (event.tuplet !== undefined) out.tuplet = event.tuplet
  if (event.articulation) out.articulation = event.articulation
  if (event.ornament) out.ornament = event.ornament
  if (event.dynamic) out.dynamic = event.dynamic
  if (event.tied_to_next) out.tied_to_next = event.tied_to_next
  return out
}

/**
 * Clone an event WITHOUT its `tied_to_next` flag. Used for cross-
 * measure moves where the event's original tie target is no longer
 * the event immediately following it after the reorder, so preserving
 * the flag would produce a dangling tie pointing at a different
 * (possibly unrelated) pitch.
 *
 * Tie decoration on cascade chains is still applied by
 * measureBalance.decoratePart — it sets `tied_to_next: true` for the
 * connective ties between cascade pieces. The stripped flag here only
 * suppresses the TRAILING tie at the end of the chain, which is what
 * dangles after a cross-measure move.
 */
function cloneEventStripTrailingTie(event: Event): Event {
  const out: Event = {
    pitches: event.pitches.map((p) => ({ ...p })),
    duration: event.duration,
  }
  if (event.tuplet !== undefined) out.tuplet = event.tuplet
  if (event.articulation) out.articulation = event.articulation
  if (event.ornament) out.ornament = event.ornament
  if (event.dynamic) out.dynamic = event.dynamic
  // Deliberately omit: tied_to_next
  return out
}

/**
 * Return `events` with the last entry's `tied_to_next` flag cleared
 * if it was set. Used on the source-measure prefix when an event with
 * a trailing tie is removed: the predecessor was tying INTO the
 * removed event, and that tie now points at a synthesized rest, which
 * is a meaningless dangling tie. Returns the input array unchanged
 * (same reference) when no strip is needed.
 */
function stripTrailingTieFromLast(events: readonly Event[]): Event[] {
  if (events.length === 0) return events as Event[]
  const last = events[events.length - 1]
  if (!last.tied_to_next) return events as Event[]
  return [...events.slice(0, -1), cloneEventStripTrailingTie(last)]
}

/**
 * Return `events` with the entry at `idx`'s `tied_to_next` flag cleared
 * if it was set. Used inside within-measure reorders where the moved
 * event's original predecessor and the new predecessor are at known
 * positions in the post-reorder array. Returns the input array
 * unchanged (same reference) when no strip is needed.
 */
function stripTieAt(events: readonly Event[], idx: number): Event[] {
  if (idx < 0 || idx >= events.length) return events as Event[]
  const ev = events[idx]
  if (!ev.tied_to_next) return events as Event[]
  return [
    ...events.slice(0, idx),
    cloneEventStripTrailingTie(ev),
    ...events.slice(idx + 1),
  ]
}

function requireMeasure(measures: readonly Measure[], idx: number, label: string): Measure {
  const m = measures[idx]
  if (!m) {
    throw new BalanceError(
      `${label}: measure ${idx} not found`,
      'unrepresentable',
      { measure: idx + 1 },
    )
  }
  return m
}

function requireEvent(measure: Measure, idx: number, measureIdx: number): Event {
  const e = measure.events[idx]
  if (!e) {
    throw new BalanceError(
      `Event ${idx} not found in measure ${measureIdx}`,
      'unrepresentable',
      { measure: measureIdx + 1, event: idx + 1 },
    )
  }
  return e
}

/**
 * Apply a map of (measureIdx → newMeasure) writes to one voice on
 * one staff. Used to commit the full set of source / destination /
 * cascade-target measure rewrites in a single immutable Score update.
 */
function applyMeasureWrites(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  writes: Map<number, Measure>,
): Score {
  return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => writes.get(i) ?? m),
  )
}

// ── reorderBalanced ──────────────────────────────────────────────────

function reorderBalanced(
  score: Score,
  op: Extract<BalancedOp, { kind: 'reorderBalanced' }>,
): Score {
  const staffIdx = staffOf(op.selection)
  const voiceIdx = voiceOf(op.selection)
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  const srcMeasureIdx = op.selection.measureIdx
  const srcEventIdx = op.selection.eventIdx
  const dstMeasureIdx = op.target.measureIdx
  const dstPosition = op.target.position32nds

  const srcMeasure = requireMeasure(measures, srcMeasureIdx, 'reorder source')
  const event = requireEvent(srcMeasure, srcEventIdx, srcMeasureIdx)

  if (event.tuplet !== undefined) {
    throw new BalanceError(
      'Cannot move a tuplet member across positions',
      'tuplet_blocked',
      { measure: srcMeasureIdx + 1, event: srcEventIdx + 1 },
    )
  }

  // Within-measure: simpler reorder with no rebalance (total preserved).
  if (srcMeasureIdx === dstMeasureIdx) {
    return reorderWithinMeasure(score, staffIdx, voiceIdx, srcMeasureIdx, srcEventIdx, dstPosition)
  }

  if (srcMeasure.events.length === 1) {
    throw new BalanceError(
      'Cannot move the only event out of a measure',
      'would_empty_measure',
      { measure: srcMeasureIdx + 1 },
    )
  }

  const capacityUnits = meterCapacityIn32nds(score.meter)
  if (dstPosition < 0 || dstPosition > capacityUnits) {
    throw new BalanceError(
      `Drop position ${dstPosition} 32nds out of bounds [0..${capacityUnits}]`,
      'unrepresentable',
      { units: dstPosition },
    )
  }

  const dstMeasure = requireMeasure(measures, dstMeasureIdx, 'reorder destination')
  const insertIdx = snapInsertionIdx(dstMeasure.events, dstPosition)
  if (insertionWouldSplitTuplet(dstMeasure.events, insertIdx)) {
    throw new BalanceError(
      'Drop position is inside a tuplet group',
      'tuplet_blocked',
      { measure: dstMeasureIdx + 1, event: insertIdx + 1 },
    )
  }

  const dstBefore = dstMeasure.events.slice(0, insertIdx)
  const dstAfter = dstMeasure.events.slice(insertIdx)
  const eventUnits = DURATION_32NDS[event.duration]

  // End-of-measure drop: append to dst, displace from back of dstBefore.
  // No cascade (event always fits in a full measure since eventUnits ≤
  // capacityUnits per the source-side validateScore invariant).
  if (insertIdx === dstMeasure.events.length) {
    const consume = consumeForRoom(dstBefore, 'back', eventUnits)
    if (consume.blocked === 'tuplet') {
      throw new BalanceError(
        'Drop would consume part of a tuplet at the destination',
        'tuplet_blocked',
        { measure: dstMeasureIdx + 1 },
      )
    }
    const restFiller = consume.leftoverUnits > 0 ? fillWithRests(consume.leftoverUnits) : []
    // Cross-measure move: strip the moved event's tied_to_next — its
    // original tie target is no longer adjacent in the new layout.
    const dstNewEvents = mergeAdjacentRests([
      ...consume.remaining,
      ...restFiller,
      cloneEventStripTrailingTie(event),
    ])
    // Source side: if the predecessor was tying INTO the moved event,
    // that tie now dangles onto the synthesized rest filler.
    const srcBefore = stripTrailingTieFromLast(srcMeasure.events.slice(0, srcEventIdx))
    const srcAfter = srcMeasure.events.slice(srcEventIdx + 1)
    const srcNewEvents = mergeAdjacentRests([
      ...srcBefore,
      ...fillWithRests(eventUnits),
      ...srcAfter,
    ])
    const writes = new Map<number, Measure>()
    writes.set(srcMeasureIdx, { events: srcNewEvents })
    writes.set(dstMeasureIdx, { events: dstNewEvents })
    return applyMeasureWrites(score, staffIdx, voiceIdx, writes)
  }

  // Front-or-mid drop: insert at insertIdx, consume from front of dstAfter.
  // If the event extends past end of measure, tie-cascade.
  const snappedPosition = sumUnits(dstBefore)
  const availableInDst = capacityUnits - snappedPosition

  // Compute cascade plan. tieSplitOver returns [[dst-events], [m+1-events], ...].
  // For the fits-in-destination case it returns a single group whose units
  // may be < availableInDst (no cascade — straight insert with displace).
  //
  // Cross-measure move: pre-strip tied_to_next from the event so the
  // cascade chain's terminal piece doesn't inherit a dangling tie (the
  // original tie target was the source's next event, which is gone).
  // Inter-piece ties WITHIN the cascade are still set by decoratePart.
  const eventForMove = cloneEventStripTrailingTie(event)
  const cascadeGroups = tieSplitOver(eventForMove, availableInDst, capacityUnits)
  const cascaded = cascadeGroups.length > 1

  const dstFirstUnits = sumUnits(cascadeGroups[0])
  let consumedFromAfter: Event[] = []
  let restFiller: Event[] = []
  if (!cascaded) {
    const consume = consumeForRoom(dstAfter, 'front', dstFirstUnits)
    if (consume.blocked === 'tuplet') {
      throw new BalanceError(
        'Drop would consume part of a tuplet at the destination',
        'tuplet_blocked',
        { measure: dstMeasureIdx + 1 },
      )
    }
    if (consume.shortfallUnits > 0) {
      throw new BalanceError(
        'Destination measure underflowed during reorder',
        'cascade_overflow',
        { measure: dstMeasureIdx + 1, units: consume.shortfallUnits },
      )
    }
    consumedFromAfter = consume.remaining as Event[]
    if (consume.leftoverUnits > 0) {
      restFiller = fillWithRests(consume.leftoverUnits)
    }
  }

  const dstNewEvents = mergeAdjacentRests([
    ...dstBefore,
    ...cascadeGroups[0],
    ...restFiller,
    ...consumedFromAfter,
  ])

  // Build cascade-target measures
  const cascadeWrites: Array<[number, Measure]> = []
  for (let g = 1; g < cascadeGroups.length; g++) {
    const targetIdx = dstMeasureIdx + g
    if (targetIdx === srcMeasureIdx) {
      throw new BalanceError(
        'Cascade would overlap the source measure',
        'cascade_overflow',
        { measure: targetIdx + 1 },
      )
    }
    const targetMeasure = measures[targetIdx]
    if (!targetMeasure) {
      throw new BalanceError(
        'Cascade goes past the last measure of the score',
        'cascade_overflow',
        { measure: targetIdx + 1 },
      )
    }
    const cascadeEvents = cascadeGroups[g]
    const cascadeUnits = sumUnits(cascadeEvents)
    const consume = consumeForRoom(targetMeasure.events, 'front', cascadeUnits)
    if (consume.blocked === 'tuplet') {
      throw new BalanceError(
        'Cascade would consume part of a tuplet in a following measure',
        'tuplet_blocked',
        { measure: targetIdx + 1 },
      )
    }
    const cascadeRest = consume.leftoverUnits > 0 ? fillWithRests(consume.leftoverUnits) : []
    const newMeasureEvents = mergeAdjacentRests([
      ...cascadeEvents,
      ...cascadeRest,
      ...consume.remaining,
    ])
    cascadeWrites.push([targetIdx, { events: newMeasureEvents }])
  }

  // Build source measure: remove event, fill the gap with rests. If
  // the predecessor was tying INTO the moved event, strip that tie —
  // it would otherwise dangle onto the synthesized rest filler.
  const srcBefore = stripTrailingTieFromLast(srcMeasure.events.slice(0, srcEventIdx))
  const srcAfter = srcMeasure.events.slice(srcEventIdx + 1)
  const srcNewEvents = mergeAdjacentRests([
    ...srcBefore,
    ...fillWithRests(eventUnits),
    ...srcAfter,
  ])

  const writes = new Map<number, Measure>()
  writes.set(srcMeasureIdx, { events: srcNewEvents })
  writes.set(dstMeasureIdx, { events: dstNewEvents })
  for (const [idx, m] of cascadeWrites) writes.set(idx, m)

  return applyMeasureWrites(score, staffIdx, voiceIdx, writes)
}

function reorderWithinMeasure(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  srcEventIdx: number,
  dstPosition: number,
): Score {
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  const measure = requireMeasure(measures, measureIdx, 'reorder within')
  const event = requireEvent(measure, srcEventIdx, measureIdx)

  // Snap against the ORIGINAL measure boundaries (the user's drop
  // position is relative to what they see). Tuplet check runs against
  // the original too. Then translate the boundary index into the
  // `withoutSrc` array (shift down by 1 for boundaries past srcEventIdx).
  const originalIdx = snapInsertionIdx(measure.events, dstPosition)
  if (insertionWouldSplitTuplet(measure.events, originalIdx)) {
    throw new BalanceError(
      'Drop position is inside a tuplet group',
      'tuplet_blocked',
      { measure: measureIdx + 1, event: originalIdx + 1 },
    )
  }
  const withoutSrc = measure.events.filter((_, i) => i !== srcEventIdx)
  const insertIdx = originalIdx > srcEventIdx ? originalIdx - 1 : originalIdx

  // Identity reorder: insertIdx maps the event back to its original
  // slot in the new layout (originalIdx === srcEventIdx OR
  // srcEventIdx + 1). In that case the array is unchanged, and we
  // preserve all tie semantics. Use the tie-preserving cloneEvent.
  const isIdentity = insertIdx === srcEventIdx
  const movedEvent = isIdentity ? cloneEvent(event) : cloneEventStripTrailingTie(event)

  let cleaned: readonly Event[] = withoutSrc
  if (!isIdentity) {
    // Strip ties at boundaries whose adjacency changed:
    //   - Original predecessor (in withoutSrc, at srcEventIdx - 1): its
    //     tied_to_next pointed at the now-moved event.
    //   - New predecessor (in cleaned, at insertIdx - 1): its tied_to_next
    //     pointed at whatever event was originally there, which is now
    //     displaced by the moved event.
    // When the two predecessors coincide (same position), stripTieAt is
    // idempotent so the double-call is safe.
    if (srcEventIdx > 0) cleaned = stripTieAt(cleaned, srcEventIdx - 1)
    if (insertIdx > 0) cleaned = stripTieAt(cleaned, insertIdx - 1)
  }

  const newEvents = [
    ...cleaned.slice(0, insertIdx),
    movedEvent,
    ...cleaned.slice(insertIdx),
  ]
  return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => (i === measureIdx ? { events: newEvents } : m)),
  )
}

// ── changeDurationBalanced ───────────────────────────────────────────

function changeDurationBalanced(
  score: Score,
  op: Extract<BalancedOp, { kind: 'changeDurationBalanced' }>,
): Score {
  const staffIdx = staffOf(op.selection)
  const voiceIdx = voiceOf(op.selection)
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  const measureIdx = op.selection.measureIdx
  const eventIdx = op.selection.eventIdx
  const measure = requireMeasure(measures, measureIdx, 'changeDuration')
  const event = requireEvent(measure, eventIdx, measureIdx)

  if (event.tuplet !== undefined) {
    throw new BalanceError(
      'Cannot change duration of a tuplet member',
      'tuplet_blocked',
      { measure: measureIdx + 1, event: eventIdx + 1 },
    )
  }

  const oldUnits = DURATION_32NDS[event.duration]
  const newUnits = DURATION_32NDS[op.duration]
  if (newUnits === oldUnits) {
    return score
  }

  const capacityUnits = meterCapacityIn32nds(score.meter)
  const before = measure.events.slice(0, eventIdx)
  const after = measure.events.slice(eventIdx + 1)
  const eventStart = sumUnits(before)

  if (newUnits < oldUnits) {
    // SHRINK: rest fills the freed space immediately after the event.
    const freed = oldUnits - newUnits
    const shrunkEvent: Event = { ...cloneEvent(event), duration: op.duration }
    const newEvents = mergeAdjacentRests([
      ...before,
      shrunkEvent,
      ...fillWithRests(freed),
      ...after,
    ])
    return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
      ms.map((m, i) => (i === measureIdx ? { events: newEvents } : m)),
    )
  }

  // GROW: consume events following this one until `delta` 32nds are
  // freed. If the measure can't absorb the growth, tie-cascade.
  const delta = newUnits - oldUnits
  const newEnd = eventStart + newUnits

  if (newEnd <= capacityUnits) {
    // Stays in measure: consume from front of `after`.
    const consume = consumeForRoom(after, 'front', delta)
    if (consume.blocked === 'tuplet') {
      throw new BalanceError(
        'Growing this note would consume part of a tuplet',
        'tuplet_blocked',
        { measure: measureIdx + 1, event: eventIdx + 1 },
      )
    }
    const rest = consume.leftoverUnits > 0 ? fillWithRests(consume.leftoverUnits) : []
    const grownEvent: Event = { ...cloneEvent(event), duration: op.duration }
    const newEvents = mergeAdjacentRests([
      ...before,
      grownEvent,
      ...rest,
      ...consume.remaining,
    ])
    return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
      ms.map((m, i) => (i === measureIdx ? { events: newEvents } : m)),
    )
  }

  // Cascade: event extends past the end of the current measure. The
  // tail is a tied chain into m+1 (and possibly m+2 within MAX cap).
  // Build a virtual "grown event" of the new total duration, then
  // tieSplitOver it given the room from eventStart to end-of-measure.
  const grownEventVirtual: Event = { ...cloneEvent(event), duration: op.duration }
  // tieSplitOver uses event.duration to size; pass the grown event.
  const roomHere = capacityUnits - eventStart
  const cascadeGroups = tieSplitOver(grownEventVirtual, roomHere, capacityUnits)

  // Same logic as reorder: replace `after` in this measure with the
  // dst-portion of the cascade; consume from front of subsequent
  // measures to make room for the cascaded tail.
  if (cascadeGroups.length === 1) {
    // Edge case: cascade rebalanced to fit in dst (shouldn't happen
    // given newEnd > capacityUnits) — fall back to in-measure growth.
    const consume = consumeForRoom(after, 'front', delta)
    if (consume.blocked === 'tuplet') {
      throw new BalanceError(
        'Growing this note would consume part of a tuplet',
        'tuplet_blocked',
      )
    }
    const rest = consume.leftoverUnits > 0 ? fillWithRests(consume.leftoverUnits) : []
    const newEvents = mergeAdjacentRests([...before, ...cascadeGroups[0], ...rest, ...consume.remaining])
    return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
      ms.map((m, i) => (i === measureIdx ? { events: newEvents } : m)),
    )
  }

  // Cascade with at least one extra measure. The dst-portion of the
  // cascaded event replaces everything from eventStart to end-of-measure;
  // `after` is fully discarded (no rest needed since cascade fills exactly).
  const writes = new Map<number, Measure>()
  writes.set(measureIdx, { events: mergeAdjacentRests([...before, ...cascadeGroups[0]]) })
  for (let g = 1; g < cascadeGroups.length; g++) {
    const targetIdx = measureIdx + g
    const targetMeasure = measures[targetIdx]
    if (!targetMeasure) {
      throw new BalanceError(
        'Cascade goes past the last measure of the score',
        'cascade_overflow',
        { measure: targetIdx + 1 },
      )
    }
    const cascadeEvents = cascadeGroups[g]
    const cascadeUnits = sumUnits(cascadeEvents)
    const consume = consumeForRoom(targetMeasure.events, 'front', cascadeUnits)
    if (consume.blocked === 'tuplet') {
      throw new BalanceError(
        'Cascade would consume part of a tuplet in a following measure',
        'tuplet_blocked',
        { measure: targetIdx + 1 },
      )
    }
    const cascadeRest = consume.leftoverUnits > 0 ? fillWithRests(consume.leftoverUnits) : []
    writes.set(targetIdx, {
      events: mergeAdjacentRests([...cascadeEvents, ...cascadeRest, ...consume.remaining]),
    })
  }

  return applyMeasureWrites(score, staffIdx, voiceIdx, writes)
}

// ── removeBalanced ───────────────────────────────────────────────────

function removeBalanced(
  score: Score,
  op: Extract<BalancedOp, { kind: 'removeBalanced' }>,
): Score {
  const staffIdx = staffOf(op.selection)
  const voiceIdx = voiceOf(op.selection)
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  const measureIdx = op.selection.measureIdx
  const eventIdx = op.selection.eventIdx
  const measure = requireMeasure(measures, measureIdx, 'remove')
  const event = requireEvent(measure, eventIdx, measureIdx)

  if (event.tuplet !== undefined) {
    throw new BalanceError(
      'Cannot remove a tuplet member (would orphan the group)',
      'tuplet_blocked',
      { measure: measureIdx + 1, event: eventIdx + 1 },
    )
  }

  const eventUnits = DURATION_32NDS[event.duration]
  const before = measure.events.slice(0, eventIdx)
  const after = measure.events.slice(eventIdx + 1)
  const newEvents = mergeAdjacentRests([
    ...before,
    ...fillWithRests(eventUnits),
    ...after,
  ])
  return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => (i === measureIdx ? { events: newEvents } : m)),
  )
}
