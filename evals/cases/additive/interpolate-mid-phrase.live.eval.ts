import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Insert 2 measures between m3 and m4 of an 8-bar piece. The piece
 * has a technique-state change at m5 (pizz.) which must remap to m7
 * after insertion (PR-3's index-remap responsibility).
 *
 * Note: a slur originally suggested for m2-m6 has been omitted from
 * this fixture. Spans reference event-IDs (not measure indices), so
 * a slur SURVIVES insertion intact without any index-remap warning.
 * That's verified at the schema level — adding it here would not
 * exercise the remap path. We exercise techniqueStates instead, which
 * IS measure-indexed and DOES need the remap.
 */

const EIGHT_BARS: Score = {
  title: 'Insert-mid demo',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'A', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'B', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
  ],
  techniqueStates: [
    {
      id: 'tech-pizz-at-m5',
      measureIdx: 5,
      staffIdx: 0,
      voiceIdx: 0,
      kind: 'pizz',
    },
  ],
}

buildLiveCase({
  id: 'interpolate-mid-phrase',
  title: 'additive: insert 2 measures between m3 and m4, technique remap',
  initialScore: EIGHT_BARS,
  userText: 'insert 2 measures between m3 and m4',
  expected: {
    measureCount: 10,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Insert-mid demo',
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'insert_measures') {
      fails.push(
        `expected dispatchTool=insert_measures, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    // Find the pizz technique change post-insertion; should be at
    // measureIdx 7 (5 + 2 inserted measures).
    const techs = result.score.techniqueStates ?? []
    const pizz = techs.find(
      (t) => t.id === 'tech-pizz-at-m5' || (t.kind === 'pizz' && t.measureIdx !== 5),
    )
    if (!pizz) {
      fails.push('expected pizz technique change to survive insertion')
    } else if (pizz.measureIdx !== 7) {
      fails.push(
        `expected pizz technique state at measureIdx=7 after insertion; got ${pizz.measureIdx}`,
      )
    }
    return fails
  },
})
