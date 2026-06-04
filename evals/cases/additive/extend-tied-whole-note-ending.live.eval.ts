import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 4-bar piece ending on a tied whole note. The last event sets
 * `tied_to_next: true` — but there is nothing to tie to. PR-3's
 * auto-downgrade-to-slur logic should either:
 *   - emit a continuation whole note with matching pitch (tie survives), OR
 *   - downgrade the tied edge to a slur and surface a warning.
 *
 * We assert measureCount=8, key/meter preserved, original bars
 * preserved, and EITHER first event of m4 has matching pitch
 * (continuation), OR result.warnings contains 'tie'.
 */
const TIED_ENDING: Score = {
  title: 'Tied ending demo',
  key: 'G',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'A', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'B', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        {
          pitches: [{ step: 'D', octave: 5 }],
          duration: 'whole',
          tied_to_next: true,
        },
      ],
    },
  ],
}

buildLiveCase({
  id: 'extend-tied-whole-note-ending',
  title: 'additive: extend a piece ending on a tied whole note',
  initialScore: TIED_ENDING,
  userText: 'add 4 more bars resolving the tied note',
  expected: {
    measureCount: 8,
    keyPreserved: 'G',
    meterPreserved: '4/4',
    titlePreserved: 'Tied ending demo',
    firstNMeasuresIdentical: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    // Either the tie was continued (first event of m4 = D5), OR a
    // warning was emitted mentioning the tie auto-downgrade.
    const m4First = result.score.measures[4]?.events[0]
    const tieContinued =
      m4First &&
      m4First.kind !== 'rest' &&
      m4First.pitches.some((p) => p.step === 'D' && p.octave === 5)
    const warnedAboutTie = (result.warnings ?? []).some((w) =>
      /\btie\b/i.test(w),
    )
    if (!tieContinued && !warnedAboutTie) {
      fails.push(
        'expected either D5 continuation in m4 (tie preserved), or a "tie" warning (auto-downgrade)',
      )
    }
    return fails
  },
})
