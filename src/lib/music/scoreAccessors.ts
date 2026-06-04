import type { Clef, Event, Measure, Score, Staff } from './types'

/**
 * Schema-shape isolator. All production reads/writes of a Score's
 * measure list flow through this module so the upcoming multi-staff /
 * multi-voice features can land without touching every caller again.
 *
 * Single-staff accessors (getMeasures, getMeasureAt, etc.) read the
 * primary staff. Staff-aware accessors (getStaffMeasures, etc.) take
 * an explicit staffIdx — 0 = primary (treble by default), 1 = the
 * optional secondStaff.
 */
export function getMeasures(score: Score): readonly Measure[] {
  return score.measures
}

export function getMeasureCount(score: Score): number {
  return score.measures.length
}

export function getMeasureAt(score: Score, measureIdx: number): Measure | undefined {
  return score.measures[measureIdx]
}

export function getEventAt(
  score: Score,
  measureIdx: number,
  eventIdx: number,
): Event | undefined {
  return score.measures[measureIdx]?.events[eventIdx]
}

/**
 * Replace the primary staff's measures array via a mapper. Returns a
 * new Score; never mutates.
 */
export function withMeasures(
  score: Score,
  fn: (measures: Measure[]) => Measure[],
): Score {
  return { ...score, measures: fn([...score.measures]) }
}

// ── Staff-aware accessors ────────────────────────────────────────────

/** Number of staves on this score (1 or 2). */
export function getStaffCount(score: Score): number {
  return score.secondStaff ? 2 : 1
}

/** Clef for the given staff. staffIdx 0 = primary, 1 = secondStaff. */
export function getStaffClef(score: Score, staffIdx: number): Clef {
  if (staffIdx === 1 && score.secondStaff) return score.secondStaff.clef
  return score.clef ?? 'treble'
}

/**
 * Resolve the clef of the staff currently being edited. Defaults to
 * staff 0 (primary) when no selection / no staffIdx. Used by toolbar
 * insert paths to pick a sensible default octave for the active staff.
 */
export function getActiveStaffClef(
  score: Score,
  staffIdx: number | undefined,
): Clef {
  return getStaffClef(score, staffIdx ?? 0)
}

/**
 * True when the given (staff, voice) has any non-rest pitch. Used by
 * the +Voice / -Voice toolbar UI to decide between a silent remove
 * and a toast-with-undo confirmation when removing an extra voice.
 */
export function voiceHasContent(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
): boolean {
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  return measures.some((m) =>
    m.events.some((e) => e.pitches.some((p) => p.step !== 'rest')),
  )
}

/**
 * True when the secondStaff exists AND any event on any voice has a
 * non-rest pitch. Used by the Staves toggle's Grand→Single pre-flight
 * to decide between a silent remove and a toast-with-undo confirmation.
 */
export function secondStaffHasContent(score: Score): boolean {
  const s = score.secondStaff
  if (!s) return false
  const allMeasures: readonly Measure[] = [
    ...s.measures,
    ...(s.extraVoices ?? []).flatMap((v) => v.measures),
  ]
  return allMeasures.some((m) =>
    m.events.some((e) => e.pitches.some((p) => p.step !== 'rest')),
  )
}

/** Measures for the given staff. */
export function getStaffMeasures(score: Score, staffIdx: number): readonly Measure[] {
  if (staffIdx === 1 && score.secondStaff) return score.secondStaff.measures
  return score.measures
}

export function getStaffMeasureAt(
  score: Score,
  staffIdx: number,
  measureIdx: number,
): Measure | undefined {
  return getStaffMeasures(score, staffIdx)[measureIdx]
}

export function getStaffEventAt(
  score: Score,
  staffIdx: number,
  measureIdx: number,
  eventIdx: number,
): Event | undefined {
  return getStaffMeasureAt(score, staffIdx, measureIdx)?.events[eventIdx]
}

/**
 * Replace a specific staff's measures via a mapper. Returns a new
 * Score; never mutates. Use this in any structural op that adds /
 * removes / reorders measures so both staves stay bar-aligned.
 */
export function withStaffMeasures(
  score: Score,
  staffIdx: number,
  fn: (measures: Measure[]) => Measure[],
): Score {
  if (staffIdx === 1) {
    if (!score.secondStaff) return score
    return {
      ...score,
      secondStaff: {
        ...score.secondStaff,
        measures: fn([...score.secondStaff.measures]),
      },
    }
  }
  return { ...score, measures: fn([...score.measures]) }
}

/**
 * Apply a mapper to every voice on every staff's measure list. Used
 * by structural ops (insertMeasureAfter, deleteMeasure,
 * duplicateMeasure) to keep all staves/voices bar-aligned with one op.
 */
export function withAllStaffMeasures(
  score: Score,
  fn: (measures: Measure[]) => Measure[],
): Score {
  const mapStaff = <T extends { measures: Measure[]; extraVoices?: Array<{ measures: Measure[] }> }>(
    s: T,
  ): T => {
    const out: T = { ...s, measures: fn([...s.measures]) }
    if (s.extraVoices) {
      out.extraVoices = s.extraVoices.map((v) => ({ measures: fn([...v.measures]) }))
    }
    return out
  }
  const primary = fn([...score.measures])
  const primaryExtras = score.extraVoices
    ? score.extraVoices.map((v) => ({ measures: fn([...v.measures]) }))
    : undefined
  const base: Score = {
    ...score,
    measures: primary,
    ...(primaryExtras ? { extraVoices: primaryExtras } : {}),
  }
  if (!score.secondStaff) return base
  return { ...base, secondStaff: mapStaff(score.secondStaff) as Staff }
}

// ── Voice-aware accessors (SATB) ─────────────────────────────────────

/** Number of voices on the given staff. Voice 0 is the primary
 *  (`measures`); voices 1..N live in `extraVoices`. */
export function getVoiceCount(score: Score, staffIdx: number): number {
  if (staffIdx === 1) {
    const s = score.secondStaff
    if (!s) return 0
    return 1 + (s.extraVoices?.length ?? 0)
  }
  return 1 + (score.extraVoices?.length ?? 0)
}

export function getVoiceMeasures(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
): readonly Measure[] {
  const staff = staffIdx === 1 ? score.secondStaff : { measures: score.measures, extraVoices: score.extraVoices }
  if (!staff) return []
  if (voiceIdx === 0) return staff.measures
  return staff.extraVoices?.[voiceIdx - 1]?.measures ?? []
}

export function getVoiceMeasureAt(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
): Measure | undefined {
  return getVoiceMeasures(score, staffIdx, voiceIdx)[measureIdx]
}

export function getVoiceEventAt(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): Event | undefined {
  return getVoiceMeasureAt(score, staffIdx, voiceIdx, measureIdx)?.events[eventIdx]
}

/**
 * Walk the score and return the first (staff, voice, measure, event)
 * position whose event.id matches `id`. Returns undefined when no
 * match.
 *
 * Linear-scan single-result counterpart to validateCrossRefs's
 * Map-building `indexEventsById`. Typical edit-op call sites resolve
 * at most two endpoint ids per op (e.g. insertHairpin), so a single
 * pass per endpoint is cheaper than constructing the full Map upfront.
 *
 * Lifted out of editOperations.ts (M11-PR-2) so the upcoming slur
 * (M12), 8va, and glissando (M20) span-edit ops can reuse it without
 * duplicating the walk.
 */
export function findEventLocationById(
  score: Score,
  id: string,
): { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number } | undefined {
  const staffCount = getStaffCount(score)
  for (let s = 0; s < staffCount; s++) {
    const voiceCount = getVoiceCount(score, s)
    for (let v = 0; v < voiceCount; v++) {
      const measures = getVoiceMeasures(score, s, v)
      for (let mi = 0; mi < measures.length; mi++) {
        const events = measures[mi].events
        for (let ei = 0; ei < events.length; ei++) {
          if (events[ei].id === id) {
            return { staffIdx: s, voiceIdx: v, measureIdx: mi, eventIdx: ei }
          }
        }
      }
    }
  }
  return undefined
}

/**
 * Replace a specific (staff, voice)'s measures via mapper. Returns a
 * new Score; never mutates.
 */
export function withVoiceMeasures(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  fn: (measures: Measure[]) => Measure[],
): Score {
  if (staffIdx === 1) {
    if (!score.secondStaff) return score
    const s = score.secondStaff
    if (voiceIdx === 0) {
      return { ...score, secondStaff: { ...s, measures: fn([...s.measures]) } }
    }
    if (!s.extraVoices) return score
    const newExtras = s.extraVoices.map((v, i) =>
      i === voiceIdx - 1 ? { ...v, measures: fn([...v.measures]) } : v,
    )
    return { ...score, secondStaff: { ...s, extraVoices: newExtras } }
  }
  // Primary staff
  if (voiceIdx === 0) {
    return { ...score, measures: fn([...score.measures]) }
  }
  if (!score.extraVoices) return score
  const newExtras = score.extraVoices.map((v, i) =>
    i === voiceIdx - 1 ? { ...v, measures: fn([...v.measures]) } : v,
  )
  return { ...score, extraVoices: newExtras }
}
