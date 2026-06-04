import type { Duration, Event, Measure, Pitch, Score } from './types'
import type { Selection } from '@/lib/chat/state'
import { meterCapacityIn32nds } from './meter'
import {
  getVoiceMeasureAt,
  getVoiceMeasures,
  withAllStaffMeasures,
  withVoiceMeasures,
} from './scoreAccessors'
import { DURATION_32NDS, fillMeasureWithRests, fillWithRests, isRest } from './measureBalance'

// Ordered largest-to-smallest for fit-pick.
const DURATIONS_DESC: Duration[] = [
  'whole', 'dotted-half', 'half', 'dotted-quarter', 'quarter',
  'dotted-eighth', 'eighth', 'sixteenth', '32nd',
]

function durationForUnits(units: number): Duration | undefined {
  for (const d of DURATIONS_DESC) {
    if (DURATION_32NDS[d] <= units) return d
  }
  return undefined
}

export interface SmartInsertResult {
  score: Score
  newSelection: Selection
  statusMessage?: string
}

export interface SmartInsertDefaults {
  pitches: Pitch[]
  duration: Duration
}

/**
 * Result of the rest-absorption scan around an insertion point.
 *
 *   pre        | new note + optional leftover-rests | post
 *   ────────────────────────────────────────────────────
 *   keep      | inserted slice                       | keep
 *
 * `startIdx` is the first index in `measure.events` to be replaced
 * (inclusive); `endIdx` is the first index NOT replaced (exclusive).
 * `absorbable` is the total 32nd-units of rests inside [startIdx,endIdx).
 */
interface AbsorbScan {
  startIdx: number
  endIdx: number
  absorbable: number
}

/**
 * From `insertAfterIdx`, decide what region of `events` can be replaced
 * by the new note + leftover rests:
 *  - If the anchor is a rest, absorb the anchor itself plus adjacent
 *    following rests.
 *  - If the anchor is a note, the insert lands AFTER the anchor; absorb
 *    only the rests that follow it.
 *
 * Tuplets are atomic (never split or absorbed); ties protect their
 * sustain (never insert between a note and the rest of its tied chain,
 * never absorb a rest carrying tied_to_next). Returns absorbable=0 when
 * the anchor itself is a tied note — caller should fall back to
 * spillover so we don't sever the tie.
 */
function scanAbsorbable(measure: Measure, insertAfterIdx: number): AbsorbScan {
  const anchor = measure.events[insertAfterIdx]
  // Edge case: anchor is a note that ties forward. Splicing a new event
  // between it and its sustain target would break the chain. Refuse to
  // absorb here.
  if (anchor && !isRest(anchor) && anchor.tied_to_next) {
    return { startIdx: insertAfterIdx + 1, endIdx: insertAfterIdx + 1, absorbable: 0 }
  }
  const startIdx = anchor && isRest(anchor) ? insertAfterIdx : insertAfterIdx + 1
  let absorbable = 0
  let endIdx = startIdx
  for (let i = startIdx; i < measure.events.length; i++) {
    const ev = measure.events[i]
    if (!isRest(ev)) break
    if (ev.tuplet !== undefined) break
    if (ev.tied_to_next) break
    absorbable += DURATION_32NDS[ev.duration]
    endIdx = i + 1
  }
  return { startIdx, endIdx, absorbable }
}

/**
 * Insert a note while respecting bar lines and consuming rests where
 * possible:
 *   1. If the target measure has rests at/after the insertion point that
 *      total >= the requested duration → REPLACE those rests with the
 *      new note plus a rest-decomposition of any leftover units.
 *   2. If the absorbable rest capacity is between a sixteenth and the
 *      requested duration → shrink-to-fit (insert a smaller note that
 *      consumes whatever's absorbable; surface a status message).
 *   3. Otherwise → spillover into a brand-new bar, fanned across all
 *      staves+voices so the score stays bar-aligned; only the active
 *      (staff, voice) gets the new event.
 *
 * `target` undefined means "append at the end of the last measure" on
 * the given (staff, voice). `staffIdx` and `voiceIdx` default to 0 so
 * legacy single-staff single-voice call sites keep working.
 */
export function smartInsertNote(
  score: Score,
  target: { measureIdx: number; eventIdx: number } | undefined,
  defaults: SmartInsertDefaults,
  staffIdx = 0,
  voiceIdx = 0,
): SmartInsertResult {
  const voiceMeasures = getVoiceMeasures(score, staffIdx, voiceIdx)
  const measureIdx = target ? target.measureIdx : voiceMeasures.length - 1
  const measure = getVoiceMeasureAt(score, staffIdx, voiceIdx, measureIdx)
  if (!measure) {
    // Defensive: callers should pass a valid (staff, voice, measure),
    // but fall back to a no-op selection rather than throwing.
    return {
      score,
      newSelection: { staffIdx, voiceIdx, measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
    }
  }
  const insertAfterIdx = target ? target.eventIdx : measure.events.length - 1
  const capacity = meterCapacityIn32nds(score.meter)
  const requested = DURATION_32NDS[defaults.duration]
  const { startIdx, endIdx, absorbable } = scanAbsorbable(measure, insertAfterIdx)

  // Build the spliced events array given a chosen inserted-event
  // duration. Always uses the absorbable region [startIdx, endIdx);
  // leftover units become rests via decompose32nds.
  const spliceWith = (insertedDuration: Duration): Event[] => {
    const inserted: Event = { pitches: defaults.pitches, duration: insertedDuration }
    const leftover = absorbable - DURATION_32NDS[insertedDuration]
    const tail = leftover > 0 ? fillWithRests(leftover) : []
    return [
      ...measure.events.slice(0, startIdx),
      inserted,
      ...tail,
      ...measure.events.slice(endIdx),
    ]
  }

  // Case 1: enough absorbable rest capacity for the requested duration.
  if (absorbable >= requested) {
    const nextEvents = spliceWith(defaults.duration)
    return {
      score: withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
        ms.map((m, i) => (i === measureIdx ? { ...m, events: nextEvents } : m)),
      ),
      newSelection: { staffIdx, voiceIdx, measureIdx, eventIdx: startIdx, pitchIdx: 0 },
    }
  }

  // Case 2: partial absorbable room (≥ sixteenth) — shrink to fit.
  if (absorbable >= DURATION_32NDS['sixteenth']) {
    const fittedDuration = durationForUnits(absorbable)
    if (fittedDuration) {
      const nextEvents = spliceWith(fittedDuration)
      return {
        score: withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
          ms.map((m, i) => (i === measureIdx ? { ...m, events: nextEvents } : m)),
        ),
        newSelection: { staffIdx, voiceIdx, measureIdx, eventIdx: startIdx, pitchIdx: 0 },
        statusMessage: `Inserted as ${fittedDuration} (limited space in m.${measureIdx + 1})`,
      }
    }
  }

  // Case 3: no usable absorbable rests — spill into a new bar. Fan a
  // meter-sized rest measure across all staves+voices so the score
  // stays bar-aligned; replace the new bar on the target (staff,voice)
  // with the inserted event followed by padding rests so it stays
  // meter-valid (resolves the under-full-spillover bug fixed in #74).
  const newEvent: Event = { pitches: defaults.pitches, duration: defaults.duration }
  const restMeasure: Measure = fillMeasureWithRests(score.meter)
  const padUnits = capacity - DURATION_32NDS[defaults.duration]
  const targetMeasure: Measure = {
    events: padUnits > 0 ? [newEvent, ...fillWithRests(padUnits)] : [newEvent],
  }
  const newMeasureIdx = measureIdx + 1

  const withRestEverywhere = withAllStaffMeasures(score, (ms) => [
    ...ms.slice(0, newMeasureIdx),
    restMeasure,
    ...ms.slice(newMeasureIdx),
  ])
  const withTargetFilled = withVoiceMeasures(withRestEverywhere, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => (i === newMeasureIdx ? targetMeasure : m)),
  )

  return {
    score: withTargetFilled,
    newSelection: { staffIdx, voiceIdx, measureIdx: newMeasureIdx, eventIdx: 0, pitchIdx: 0 },
    statusMessage: `Started measure ${newMeasureIdx + 1}`,
  }
}
