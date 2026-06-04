import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 4-bar piano grand-staff (treble RH + bass LH). Extend by 4 bars
 * preserving the hand-division (RH stays on treble, LH on bass).
 *
 * Despite the "destructive" bucket — this is a structural extension
 * across multi-voice content. It's destructive in the sense that a
 * naive `regenerate_all` would lose the hand-division; the right
 * dispatch is `extend_composition` on BOTH staves.
 */
const PIANO_4_BARS: Score = {
  title: 'Piano grand staff',
  key: 'C',
  meter: '4/4',
  clef: 'treble',
  measures: [
    // RH: arpeggio CEG-CEG-CEG-CEG (quarter notes)
    {
      events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 6 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 6 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 6 }], duration: 'quarter' },
      ],
    },
  ],
  secondStaff: {
    clef: 'bass',
    measures: [
      // LH: bass octaves C2-C3 then F2-F3 ...
      {
        events: [
          {
            pitches: [
              { step: 'C', octave: 2 },
              { step: 'C', octave: 3 },
            ],
            duration: 'whole',
          },
        ],
      },
      {
        events: [
          {
            pitches: [
              { step: 'G', octave: 2 },
              { step: 'G', octave: 3 },
            ],
            duration: 'whole',
          },
        ],
      },
      {
        events: [
          {
            pitches: [
              { step: 'F', octave: 2 },
              { step: 'F', octave: 3 },
            ],
            duration: 'whole',
          },
        ],
      },
      {
        events: [
          {
            pitches: [
              { step: 'C', octave: 2 },
              { step: 'C', octave: 3 },
            ],
            duration: 'whole',
          },
        ],
      },
    ],
  },
}

buildLiveCase({
  id: 'multi-voice-piano-hand-division',
  title: 'destructive: extend piano grand-staff preserving hand-division',
  initialScore: PIANO_4_BARS,
  userText: 'extend by 4 bars with the same hand division',
  expected: {
    measureCount: 8,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Piano grand staff',
    firstNMeasuresIdentical: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'extend_composition') {
      fails.push(
        `expected dispatchTool=extend_composition, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    const after = result.score
    // Bass staff must exist and have 8 bars (matched length).
    if (!after.secondStaff) {
      fails.push('expected secondStaff to be present after extension')
    } else if (after.secondStaff.measures.length !== 8) {
      fails.push(
        `expected secondStaff to have 8 measures (matched extension); got ${after.secondStaff.measures.length}`,
      )
    } else {
      // Bass-staff bars 0-3 should be byte-identical to original.
      // Check by reasoning: pitches in the bass-staff new bars 4-7
      // should be bass-clef-appropriate (octave <= 3 for at least
      // some bottom note of every event).
      const newBass = after.secondStaff.measures.slice(4)
      const allLow = newBass.every((m) =>
        m.events.every((e) => {
          if (e.kind === 'rest') return true
          return e.pitches.some((p) => typeof p.octave === 'number' && p.octave <= 3)
        }),
      )
      if (!allLow) {
        fails.push(
          'expected bass-staff extension to keep all events in octave ≤ 3 (hand-division preserved)',
        )
      }
    }
    return fails
  },
})
