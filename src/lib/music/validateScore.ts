import { ScoreSchema, type Event, type Measure, type Meter, type Score } from './types'
import { meterInEighths } from './meter'
import { ValidationError } from './errors'
import { getStaffCount, getStaffMeasures, getVoiceCount, getVoiceMeasures } from './scoreAccessors'
import { validateCrossRefs } from './validateCrossRefs'

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

// Tuplet ratios: n notes occupy the time of the indicated value.
// Triplet (3) = 3 notes in time of 2; etc.
const TUPLET_RATIO: Record<number, number> = {
  3: 2 / 3,
  5: 4 / 5,
  6: 4 / 6,
  7: 4 / 7,
}

function eventDurationInEighths(event: Event): number {
  const base = DURATION_VALUE_EIGHTHS[event.duration]
  if (event.tuplet) {
    return base * TUPLET_RATIO[event.tuplet]
  }
  return base
}

function validateMeasureDuration(
  measure: Measure,
  meter: Meter,
  measureIdx: number,
): void {
  const sum = measure.events.reduce((acc, e) => acc + eventDurationInEighths(e), 0)
  const expected = meterInEighths(meter)
  // Pickup (anacrusis) and final-partial measures are allowed to be
  // SHORTER than the meter's full capacity. They must not be longer.
  if (measure.isPickup || measure.isFinalPartial) {
    if (sum > expected + 0.001) {
      throw new ValidationError(
        `Measure ${measureIdx + 1} (${measure.isPickup ? 'pickup' : 'final partial'}): duration sum is ${sum} eighths, exceeds meter capacity ${expected} for ${meter}`,
        'measure_duration_mismatch',
        { measure: measureIdx + 1 },
      )
    }
    return
  }
  if (Math.abs(sum - expected) > 0.001) {
    throw new ValidationError(
      `Measure ${measureIdx + 1}: duration sum is ${sum} eighths, expected ${expected} for meter ${meter}`,
      'measure_duration_mismatch',
      { measure: measureIdx + 1 },
    )
  }
}

function validateMeasureTuplets(measure: Measure, measureIdx: number): void {
  let i = 0
  while (i < measure.events.length) {
    const ev = measure.events[i]
    if (ev.tuplet) {
      let count = 1
      while (
        i + count < measure.events.length &&
        measure.events[i + count].tuplet === ev.tuplet
      ) {
        count++
      }
      if (count < ev.tuplet) {
        throw new ValidationError(
          `Tuplet group starting at event ${i + 1} has ${count} events; expected ${ev.tuplet} (no cross-barline tuplets)`,
          'tuplet_incomplete',
          { measure: measureIdx + 1, event: i + 1 },
        )
      }
      i += ev.tuplet
    } else {
      i++
    }
  }
}

function validateMeasureChords(measure: Measure, measureIdx: number): void {
  measure.events.forEach((ev, eventIdx) => {
    if (ev.pitches.length > 1 && ev.pitches.some((p) => p.step === 'rest')) {
      throw new ValidationError(
        'A rest cannot appear inside a chord stack',
        'rest_in_chord',
        { measure: measureIdx + 1, event: eventIdx + 1 },
      )
    }
  })
}

/**
 * Validate an unknown input as a Score. Runs zod schema validation
 * followed by semantic checks (duration sums, tuplet completeness,
 * rest-in-chord). Throws ValidationError on any failure.
 */
export function validateScore(input: unknown): Score {
  const parsed = ScoreSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(
      `Schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'schema_error',
    )
  }
  const score = parsed.data
  const staffCount = getStaffCount(score)
  const primaryMeasures = getStaffMeasures(score, 0)
  const targetMeasureCount = primaryMeasures.length

  // Bar-alignment invariant: every voice on every staff has the same
  // measures.length so the rendered system stays in sync.
  for (let s = 0; s < staffCount; s++) {
    const vc = getVoiceCount(score, s)
    for (let v = 0; v < vc; v++) {
      const measures = getVoiceMeasures(score, s, v)
      if (measures.length !== targetMeasureCount) {
        throw new ValidationError(
          `Staff ${s} voice ${v} has ${measures.length} measures; primary has ${targetMeasureCount}. All voices must be bar-aligned.`,
          'schema_error',
        )
      }
    }
  }

  for (let s = 0; s < staffCount; s++) {
    const vc = getVoiceCount(score, s)
    for (let v = 0; v < vc; v++) {
      const measures = getVoiceMeasures(score, s, v)
      measures.forEach((measure, i) => {
        validateMeasureTuplets(measure, i)
        validateMeasureChords(measure, i)
        validateMeasureDuration(measure, score.meter, i)
      })
    }
  }

  // Phase 1 cross-reference invariants (spans, jump-marker refs,
  // per-pitch tie targets, marker uniqueness, volta endings). Each
  // throws ValidationError on first violation with a specific code.
  validateCrossRefs(score)

  return score
}

/**
 * Server-side ABC string validation via abcjs.parseOnly. Throws on hard
 * parse failure; warnings are returned for callers to log.
 * Must only be called server-side (abcjs touches window on full import,
 * but parseOnly works in Node per Phase 0 spike).
 */
export async function validateAbc(abc: string): Promise<{ warnings: string[] }> {
  const mod = await import('abcjs')
  const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
  const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] }>
  if (!tunes || !tunes[0]) {
    throw new ValidationError('abcjs could not parse the transpiled ABC string', 'abc_parse_failed')
  }
  return { warnings: tunes[0].warnings ?? [] }
}
