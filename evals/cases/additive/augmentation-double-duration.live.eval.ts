import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Augmentation: double every duration. Defensible outcomes:
 *  (a) measureCount = 4, every event's duration doubled (eighth→quarter,
 *      quarter→half, half→whole, whole→breve).
 *  (b) measureCount = 8 (double-bar augmentation), same total duration
 *      but spread across more bars at the same meter.
 *
 * We assert sumOfDurations(after) ≈ 2 × sumOfDurations(before) and
 * key/meter/title preserved.
 */
const FOUR_BARS: Score = {
  title: 'Augmentation demo',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'B', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'eighth' },
        { pitches: [{ step: 'F', octave: 5 }], duration: 'half' },
      ],
    },
    {
      events: [{ pitches: [{ step: 'G', octave: 5 }], duration: 'whole' }],
    },
  ],
}

/** Coarse beat-equivalent value of each duration token. */
function durationBeats(d: string): number {
  switch (d) {
    case 'whole':
      return 4
    case 'half':
      return 2
    case 'quarter':
      return 1
    case 'eighth':
      return 0.5
    case 'sixteenth':
      return 0.25
    case 'thirty-second':
      return 0.125
    case 'breve':
      return 8
    case 'sixty-fourth':
      return 0.0625
    default:
      return 0
  }
}

function totalBeats(score: Score): number {
  let sum = 0
  for (const m of score.measures) {
    for (const e of m.events) {
      sum += durationBeats(e.duration as string)
    }
  }
  return sum
}

const ORIGINAL_BEATS = totalBeats(FOUR_BARS)

buildLiveCase({
  id: 'augmentation-double-duration',
  title: 'additive: double every duration',
  initialScore: FOUR_BARS,
  userText: 'double the duration of every note',
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Augmentation demo',
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    const after = totalBeats(result.score)
    const expected = ORIGINAL_BEATS * 2
    // Allow ±10% slack — the model may legitimately not perfectly
    // double a tied/duration-limited final note, but the gross sum
    // must approximately double.
    if (Math.abs(after - expected) / expected > 0.1) {
      fails.push(
        `expected total beats ≈ ${expected} (2x original ${ORIGINAL_BEATS}); got ${after}`,
      )
    }
    return fails
  },
})
