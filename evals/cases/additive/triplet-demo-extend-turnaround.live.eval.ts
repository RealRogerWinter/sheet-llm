import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Live equivalent of the PR-2 mock repro
 * (additive/triplet-demo-extend.mock.eval.ts). Asserts that the
 * production model picks `extend_composition` for the M3.5 incident
 * prompt and preserves the 4 original bars byte-identically.
 */
const TRIPLET_DEMO_4_BARS: Score = {
  title: 'Triplet demo',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

buildLiveCase({
  id: 'triplet-demo-extend-turnaround',
  title: 'additive: extend 4-bar triplet demo with i-iv-V turnaround',
  initialScore: TRIPLET_DEMO_4_BARS,
  userText: 'add 4 more bars with a i iv v turnaround',
  expected: {
    measureCount: 8,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Triplet demo',
    firstNMeasuresIdentical: 4,
  },
  extraAssertions: (result) => {
    const failures: string[] = []
    if (result.dispatchTool !== 'extend_composition') {
      failures.push(
        `expected dispatchTool=extend_composition, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    return failures
  },
})
