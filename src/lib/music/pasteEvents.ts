import type { Event, Measure, Score } from './types'
import type { Selection } from '@/lib/chat/state'
import { getVoiceMeasureAt, withAllStaffMeasures, withVoiceMeasures } from './scoreAccessors'
import { meterCapacityIn32nds } from './meter'
import {
  BalanceError,
  DURATION_32NDS,
  fillMeasureWithRests,
  fillWithRests,
  isRest,
  mergeAdjacentRests,
  tieSplitOver,
} from './measureBalance'
import { createEventId } from './eventIds'

export interface PasteEventsResult {
  ok: boolean
  score: Score
  newSelection?: Selection
  statusMessage?: string
}

export interface PasteEventsTarget {
  staffIdx: number
  voiceIdx: number
  measureIdx: number
  /** Event index to insert AFTER; -1 inserts at the front of the bar. */
  insertAfterIdx: number
}

/** Deep clone + mint a fresh id so pasted events never share identity with
 *  the clipboard entry or each other (spans address events by id). */
function withFreshIds(events: Event[]): Event[] {
  return events.map((e) => ({ ...(JSON.parse(JSON.stringify(e)) as Event), id: createEventId() }))
}

/**
 * Pack a run of events into a sequence of meter-valid measures. An event
 * that would straddle a barline is tie-split via `tieSplitOver`; the final
 * partial measure is rest-padded to capacity. Throws BalanceError if a
 * tuplet straddles a barline (un-splittable).
 */
function packEventsIntoMeasures(events: Event[], capacity: number): Measure[] {
  const measures: Measure[] = []
  let cur: Event[] = []
  let used = 0
  const flush = (evs: Event[]) => measures.push({ events: mergeAdjacentRests(evs) })

  for (const ev of events) {
    const u = DURATION_32NDS[ev.duration]
    if (used + u <= capacity) {
      cur.push(ev)
      used += u
      if (used === capacity) {
        flush(cur)
        cur = []
        used = 0
      }
      continue
    }
    // Straddles the barline → split into per-measure groups (room < capacity
    // here, so room >= 1).
    const room = capacity - used
    const groups = tieSplitOver(ev, room, capacity)
    cur.push(...groups[0])
    flush(cur)
    cur = []
    used = 0
    for (let i = 1; i < groups.length - 1; i++) flush(groups[i])
    if (groups.length > 1) {
      const last = groups[groups.length - 1]
      cur = [...last]
      used = last.reduce((s, e) => s + DURATION_32NDS[e.duration], 0)
      if (used === capacity) {
        flush(cur)
        cur = []
        used = 0
      }
    }
  }
  if (cur.length > 0) {
    const pad = capacity - used
    if (pad > 0) cur.push(...fillWithRests(pad))
    flush(cur)
  }
  return measures
}

/**
 * Paste a run of full events (preserving articulations/dynamics/etc., with
 * fresh ids) into the destination (staff, voice, measure) at
 * `insertAfterIdx`.
 *
 * 1. If the run fits the contiguous rest space at the insert point (the
 *    same absorb-rests rule as `smartInsertNote`), splice it in + pad the
 *    leftover. The common case (empty bars, trailing rests).
 * 2. Otherwise SPILL: pack the run into new meter-valid bars (tie-splitting
 *    events that straddle barlines), fan rest measures across every other
 *    staff/voice to stay bar-aligned, and insert them after the destination
 *    bar. Only a tuplet straddling a barline is refused (un-splittable).
 *
 * Never produces an over-full (invalid) bar.
 */
export function pasteEvents(score: Score, target: PasteEventsTarget, events: Event[]): PasteEventsResult {
  const { staffIdx, voiceIdx, measureIdx, insertAfterIdx } = target
  const measure = getVoiceMeasureAt(score, staffIdx, voiceIdx, measureIdx)
  if (!measure || events.length === 0) return { ok: false, score }

  const fresh = withFreshIds(events)
  const runUnits = fresh.reduce((sum, e) => sum + DURATION_32NDS[e.duration], 0)

  // Mirror smartInsertNote.scanAbsorbable: if the anchor is a (non-tied)
  // rest, absorb it; otherwise insert AFTER the anchor and absorb the
  // following contiguous rests. A tuplet or tied rest stops the scan.
  const anchor = measure.events[insertAfterIdx]
  const startIdx =
    anchor && isRest(anchor) && !anchor.tied_to_next ? insertAfterIdx : insertAfterIdx + 1
  const spliceStart = Math.max(0, startIdx)
  let absorbable = 0
  let endIdx = spliceStart
  for (let i = spliceStart; i < measure.events.length; i++) {
    const ev = measure.events[i]
    if (!isRest(ev) || ev.tuplet !== undefined || ev.tied_to_next) break
    absorbable += DURATION_32NDS[ev.duration]
    endIdx = i + 1
  }

  // Case 1: fits the absorbable rest space → splice into this bar.
  if (runUnits <= absorbable) {
    const leftover = absorbable - runUnits
    const tail = leftover > 0 ? fillWithRests(leftover) : []
    const nextEvents = [
      ...measure.events.slice(0, spliceStart),
      ...fresh,
      ...tail,
      ...measure.events.slice(endIdx),
    ]
    const nextScore = withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
      ms.map((m, i) => (i === measureIdx ? { ...m, events: nextEvents } : m)),
    )
    return {
      ok: true,
      score: nextScore,
      newSelection: { staffIdx, voiceIdx, measureIdx, eventIdx: spliceStart, pitchIdx: 0 },
      statusMessage: `Pasted ${fresh.length} note${fresh.length === 1 ? '' : 's'}`,
    }
  }

  // Case 2: overflow → spill into new bars after the destination measure.
  const capacity = meterCapacityIn32nds(score.meter)
  let packed: Measure[]
  try {
    packed = packEventsIntoMeasures(fresh, capacity)
  } catch (e) {
    if (e instanceof BalanceError) {
      return { ok: false, score, statusMessage: 'Can’t paste this run here (a tuplet would span a barline).' }
    }
    throw e
  }

  const newMeasureIdx = measureIdx + 1
  const withRestBars = withAllStaffMeasures(score, (ms) => [
    ...ms.slice(0, newMeasureIdx),
    ...packed.map(() => fillMeasureWithRests(score.meter)),
    ...ms.slice(newMeasureIdx),
  ])
  const withPacked = withVoiceMeasures(withRestBars, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => (i >= newMeasureIdx && i < newMeasureIdx + packed.length ? packed[i - newMeasureIdx] : m)),
  )
  return {
    ok: true,
    score: withPacked,
    newSelection: { staffIdx, voiceIdx, measureIdx: newMeasureIdx, eventIdx: 0, pitchIdx: 0 },
    statusMessage: `Pasted ${fresh.length} note${fresh.length === 1 ? '' : 's'} into ${packed.length} new bar${packed.length === 1 ? '' : 's'}`,
  }
}
