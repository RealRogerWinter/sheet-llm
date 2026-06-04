import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 4-bar piece with a meter change from 4/4 to 3/4 at measure 3.
 * Extending by 4 bars in 3/4 must:
 *   - preserve original 4 bars (measureCount → 8)
 *   - keep the meter marker at measureIdx 2 (the original 3/4 change
 *     boundary) intact
 *   - emit new bars that pass the 3/4 capacity check
 */
const METER_CHANGE: Score = {
  title: 'Meter change demo',
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
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    // Meter change to 3/4 here.
    {
      events: [
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
  markers: [{ measureIdx: 2, meter: '3/4' }],
}

buildLiveCase({
  id: 'extend-across-meter-change',
  title: 'additive: extend 4 bars in 3/4 across a mid-piece meter change',
  initialScore: METER_CHANGE,
  userText: 'add 4 more bars continuing in 3/4',
  expected: {
    measureCount: 8,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Meter change demo',
    firstNMeasuresIdentical: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'extend_composition') {
      fails.push(
        `expected dispatchTool=extend_composition, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    // The original meter marker at idx 2 must survive.
    const meterMarker = (result.score.markers ?? []).find(
      (m) => m.measureIdx === 2 && m.meter === '3/4',
    )
    if (!meterMarker) {
      fails.push('expected meter=3/4 marker at measureIdx=2 to survive extension')
    }
    return fails
  },
})
