import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 8-bar A section in C major. User asks for a B section in A minor
 * (relative minor) for 8 more bars. Expected:
 *   - measureCount 16
 *   - bars 0-7 byte-identical (A section preserved)
 *   - bars 8-15 in A minor: either a KeyMarker at m8, OR all natural
 *     pitches consistent with Am (no sharps/flats in the new bars)
 *   - title preserved
 *   - dispatched to extend_composition (the hint signals key change)
 */
const A_SECTION_C: Score = {
  title: 'AB form demo',
  key: 'C',
  meter: '4/4',
  measures: Array.from({ length: 8 }, (_, i) => ({
    events: [
      {
        pitches: [
          { step: 'C', octave: 4 },
          { step: 'E', octave: 4 },
          { step: 'G', octave: 4 },
        ],
        duration: 'whole' as const,
      },
    ],
    ...(i === 7 ? { endBarline: 'final' as const } : {}),
  })),
}

buildLiveCase({
  id: 'add-B-section-key-change',
  title: 'additive: extend with B section in relative minor (A minor)',
  initialScore: A_SECTION_C,
  userText: 'add a B section in the relative minor (A minor) for 8 more bars',
  expected: {
    measureCount: 16,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'AB form demo',
    firstNMeasuresIdentical: 8,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'extend_composition') {
      fails.push(
        `expected dispatchTool=extend_composition, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    // Look for either a Key marker at measureIdx >= 8 setting key Am,
    // OR no sharps/flats in measures 8..15.
    const markers = result.score.markers ?? []
    const hasKeyMarker = markers.some(
      (m) => m.measureIdx >= 8 && m.key === 'Am',
    )
    const newBars = result.score.measures.slice(8)
    const hasAccidentalInB = newBars.some((m) =>
      m.events.some((e) => {
        if (e.kind === 'rest') return false
        return e.pitches.some(
          (p) => p.accidental === 'sharp' || p.accidental === 'flat',
        )
      }),
    )
    if (!hasKeyMarker && hasAccidentalInB) {
      fails.push(
        'expected either a KeyMarker(Am) at measureIdx>=8, or new bars to be all-natural (Am-consistent)',
      )
    }
    return fails
  },
})
