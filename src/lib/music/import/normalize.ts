import type { Event, Measure, Meter, Score } from '../types'
import { meterInEighths } from '../meter'
import {
  getMeasures,
  getStaffCount,
  getVoiceCount,
  withAllStaffMeasures,
  withMeasures,
} from '../scoreAccessors'
import type { ImportOptions, ImportWarning } from './types'

/**
 * Sanity ceiling on importable score length — defends against a runaway
 * parser or a pathological input (e.g. a million-bar generated MIDI),
 * not against real music. Anything within ~5 orders of magnitude of a
 * full symphony movement should pass through untouched. The real
 * resource defenses live at the request boundary (per-score JSON byte
 * cap in /api/sessions/:id/versions/batch) and on the renderer.
 *
 * Exported so tests can reference it without hardcoding the threshold.
 */
export const MAX_MEASURES = 10000

const DURATION_VALUE_EIGHTHS: Record<Event['duration'], number> = {
  whole: 8,
  'dotted-half': 6,
  half: 4,
  'dotted-quarter': 3,
  quarter: 2,
  'dotted-eighth': 1.5,
  eighth: 1,
  sixteenth: 0.5,
  '32nd': 0.25,
}

function measureLengthEighths(measure: Measure): number {
  return measure.events.reduce((acc, e) => acc + DURATION_VALUE_EIGHTHS[e.duration], 0)
}

/**
 * Pad a partial first measure (anacrusis / pickup) with leading rests
 * so it sums to the full meter. The schema forbids partial measures
 * and the validator would otherwise reject the score. Returns the
 * padded measure list and a flag indicating whether padding was
 * applied.
 *
 * If the first measure is already full or *over*-full, we leave it
 * alone — over-full is a real validation error that should surface.
 */
function padAnacrusis(
  measures: Measure[],
  meter: Meter,
): { measures: Measure[]; padded: boolean; padEighths: number; leadingRests: Event[] } {
  if (measures.length === 0)
    return { measures, padded: false, padEighths: 0, leadingRests: [] }
  const first = measures[0]
  const have = measureLengthEighths(first)
  const want = meterInEighths(meter)
  if (have >= want || have <= 0)
    return { measures, padded: false, padEighths: 0, leadingRests: [] }
  const missing = want - have
  const leadingRests = synthesizeRests(missing)
  if (leadingRests.length === 0) {
    // The gap doesn't decompose into supported rest durations (very
    // unusual — e.g. 1/16 in a 4/4 with no 1/16 in the enum). Leave
    // the measure alone; downstream validator will surface it.
    return { measures, padded: false, padEighths: 0, leadingRests: [] }
  }
  return {
    measures: [{ events: [...leadingRests, ...first.events] }, ...measures.slice(1)],
    padded: true,
    padEighths: missing,
    leadingRests,
  }
}

/**
 * Greedy decomposition of `eighths` into the largest available rest
 * durations. Used by padAnacrusis. Returns an empty array if any
 * remainder isn't representable.
 */
function synthesizeRests(eighths: number): Event[] {
  const order: Event['duration'][] = [
    'whole',
    'dotted-half',
    'half',
    'dotted-quarter',
    'quarter',
    'dotted-eighth',
    'eighth',
    'sixteenth',
    '32nd',
  ]
  const out: Event[] = []
  let remaining = eighths
  for (const d of order) {
    const v = DURATION_VALUE_EIGHTHS[d]
    while (remaining + 1e-6 >= v) {
      out.push({ pitches: [{ step: 'rest', octave: 4 }], duration: d })
      remaining -= v
    }
  }
  if (Math.abs(remaining) > 1e-6) return []
  return out
}

/**
 * Truncate to MAX_MEASURES. When `truncateIfLong` is false and the
 * score is too long, returns a `block` warning so the caller can
 * surface a choice in the UI.
 */
function truncate(
  measures: Measure[],
  options: ImportOptions,
): { measures: Measure[]; warnings: ImportWarning[] } {
  if (measures.length <= MAX_MEASURES) return { measures, warnings: [] }
  const original = measures.length
  if (!options.truncateIfLong) {
    return {
      measures,
      warnings: [
        {
          severity: 'block',
          code: 'too_long',
          message: `Score is ${original} bars; the limit is ${MAX_MEASURES}. Choose to import the first ${MAX_MEASURES} bars or cancel.`,
          meta: { originalMeasureCount: original, cap: MAX_MEASURES },
        },
      ],
    }
  }
  return {
    measures: measures.slice(0, MAX_MEASURES),
    warnings: [
      {
        severity: 'info',
        code: 'too_long',
        message: `Kept the first ${MAX_MEASURES} of ${original} bars.`,
        meta: { originalMeasureCount: original, cap: MAX_MEASURES },
      },
    ],
  }
}

/**
 * Apply post-parse normalization shared across all importers:
 * anacrusis padding (info warning) + truncation (block until user
 * opts in via truncateIfLong, then info). Caller threads through the
 * format-specific warnings emitted upstream (multi-voice, key
 * changes, etc.) and combines them with what this function returns.
 *
 * Multi-voice safety: anacrusis padding is computed from voice 0 of
 * the primary staff ONLY, then the same leading rests are prepended
 * to every voice on every staff. Per-voice padding would desync
 * voices when their first measures have different durations.
 * Truncation is global: every voice keeps the same measure-count cap.
 */
export function normalize(score: Score, options: ImportOptions): { score: Score; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = []

  // Compute pad amount from voice 0 of the primary staff only.
  const primary = [...getMeasures(score)]
  const { measures: paddedPrimary, padded, padEighths, leadingRests } = padAnacrusis(
    primary,
    score.meter,
  )
  if (padded) {
    warnings.push({
      severity: 'info',
      code: 'anacrusis_padded',
      message: `Pickup measure padded with ${padEighths} eighth-note rest(s) so it fills the meter.`,
      meta: { padEighths },
    })
  }

  // Fan the leading rests out to every voice on every staff so they
  // stay bar-aligned. Single-staff single-voice scores reduce to the
  // existing behavior.
  let padded2: Score = padded
    ? withAllStaffMeasures(score, (ms) => prependLeadingRests(ms, leadingRests))
    : score
  // Voice 0 of the primary staff already has its computed pad — make
  // sure we don't double-apply.
  if (padded) {
    padded2 = withMeasures(padded2, () => paddedPrimary)
  }
  // Bar-alignment safety check: a voice whose own first measure was
  // already full but we prepended rests to → would now over-fill. For
  // those voices, the prepended rests should be merged-and-redistributed.
  // For the common case (anacrusis: all voices start partial),
  // prepending the same leading-rest sequence keeps them aligned.

  const { measures: truncated, warnings: truncWarnings } = truncate(
    [...getMeasures(padded2)],
    options,
  )
  warnings.push(...truncWarnings)

  // Truncate every voice to the same cap so they remain bar-aligned.
  const finalScore = withAllStaffMeasures(padded2, (ms) =>
    ms.length > truncated.length ? ms.slice(0, truncated.length) : ms,
  )
  // Replace the primary's measures with the truncated copy (truncated
  // also captured any anacrusis padding that withMeasures above wrote
  // to primary; this just ensures the global cap applies).
  const sealed = withMeasures(finalScore, () => truncated)

  void getStaffCount
  void getVoiceCount

  return {
    score: sealed,
    warnings,
  }
}

/**
 * Prepend a fixed leading-rest sequence to the first measure of a
 * measure list. Used by normalize() to apply the same anacrusis pad
 * across every voice on every staff.
 */
function prependLeadingRests(measures: Measure[], leading: Event[]): Measure[] {
  if (leading.length === 0 || measures.length === 0) return measures
  return [
    { events: [...leading, ...measures[0].events] },
    ...measures.slice(1),
  ]
}
