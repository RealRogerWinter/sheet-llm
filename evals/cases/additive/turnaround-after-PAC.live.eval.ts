import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 4-bar phrase ending in a perfect-authentic cadence (F → G → C → C
 * final). The cadence-at-boundary detector in PR-3 should warn when
 * the extender sees a V-I + final-barline pattern. Live case asserts:
 *   - measureCount = 8, key/meter preserved
 *   - bars 0-3 byte-identical
 *   - dispatched to extend_composition
 *   - cadenceAtBoundary === true (warn-only flag set)
 */
const PAC_PHRASE: Score = {
  title: 'PAC phrase',
  key: 'C',
  meter: '4/4',
  measures: [
    // F major — IV
    {
      events: [
        {
          pitches: [
            { step: 'F', octave: 4 },
            { step: 'A', octave: 4 },
            { step: 'C', octave: 5 },
          ],
          duration: 'whole',
        },
      ],
    },
    // G major — V
    {
      events: [
        {
          pitches: [
            { step: 'G', octave: 4 },
            { step: 'B', octave: 4 },
            { step: 'D', octave: 5 },
          ],
          duration: 'whole',
        },
      ],
    },
    // C major — I (penultimate)
    {
      events: [
        {
          pitches: [
            { step: 'C', octave: 4 },
            { step: 'E', octave: 4 },
            { step: 'G', octave: 4 },
          ],
          duration: 'whole',
        },
      ],
    },
    // C major — I (final)
    {
      events: [
        {
          pitches: [
            { step: 'C', octave: 4 },
            { step: 'E', octave: 4 },
            { step: 'G', octave: 4 },
          ],
          duration: 'whole',
        },
      ],
      endBarline: 'final',
    },
  ],
}

buildLiveCase({
  id: 'turnaround-after-PAC',
  title: 'additive: extend after a PAC, cadenceAtBoundary fires',
  initialScore: PAC_PHRASE,
  userText: 'add 4 more bars continuing the ideas',
  expected: {
    measureCount: 8,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'PAC phrase',
    firstNMeasuresIdentical: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'extend_composition') {
      fails.push(
        `expected dispatchTool=extend_composition, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    if (result.cadenceAtBoundary !== true) {
      fails.push(
        `expected cadenceAtBoundary=true (V-I + final barline pattern), got ${result.cadenceAtBoundary ?? '<unset>'}`,
      )
    }
    return fails
  },
})
