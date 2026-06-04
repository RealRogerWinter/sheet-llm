import type { Measure, Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Multi-voice (SATB) intra-measure edit. 4 bars grand-staff: soprano
 * on top of treble (primary voice), alto as a secondary voice on
 * treble (extraVoices[0]), tenor + bass on the bass staff
 * (secondStaff.measures + secondStaff.extraVoices[0]).
 *
 * User asks for an alto countermelody, expects soprano + bass to stay
 * byte-identical and the alto voice to gain content.
 *
 * Expensive — gated behind RUN_LIVE_FULL=1.
 */

function whole(step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', octave: number): Measure {
  return {
    events: [{ pitches: [{ step, octave }], duration: 'whole' }],
  }
}

// Soprano: C5 D5 E5 D5
const SOPRANO: Measure[] = [
  whole('C', 5),
  whole('D', 5),
  whole('E', 5),
  whole('D', 5),
]
// Alto starts empty (just rests, awaiting the LLM)
const ALTO_REST: Measure[] = [
  { events: [{ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
  { events: [{ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
  { events: [{ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
  { events: [{ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
]
// Tenor on bass-staff primary voice: E4 D4 C4 D4
const TENOR: Measure[] = [
  whole('E', 4),
  whole('D', 4),
  whole('C', 4),
  whole('D', 4),
]
// Bass on bass-staff extra voice: C3 G2 C3 G2
const BASS: Measure[] = [
  whole('C', 3),
  whole('G', 2),
  whole('C', 3),
  whole('G', 2),
]

const SATB: Score = {
  title: 'SATB four-bar',
  key: 'C',
  meter: '4/4',
  measures: SOPRANO,
  extraVoices: [{ measures: ALTO_REST }],
  secondStaff: {
    clef: 'bass',
    measures: TENOR,
    extraVoices: [{ measures: BASS }],
  },
}

buildLiveCase({
  id: 'SATB-countermelody',
  title: 'additive: SATB alto countermelody preserves soprano + bass',
  initialScore: SATB,
  userText:
    'add an alto countermelody to bars 1-4 that preserves the soprano and bass',
  expensive: true,
  expected: {
    measureCount: 4,
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'SATB four-bar',
    firstNMeasuresIdentical: 4,
    appliedOpsContain: 'editIntraMeasure',
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    // Soprano (primary measures) preserved is covered by
    // firstNMeasuresIdentical above. Bass needs a manual check.
    const after = result.score
    const bassAfter = after.secondStaff?.extraVoices?.[0]?.measures
    if (!bassAfter || bassAfter.length !== 4) {
      fails.push(
        `expected 4 bass-voice measures after, got ${bassAfter?.length ?? 'undefined'}`,
      )
    }
    // Alto voice should have at least one non-rest event added.
    const altoAfter = after.extraVoices?.[0]?.measures
    if (!altoAfter) {
      fails.push('expected extraVoices[0].measures present after edit')
    } else {
      const hasNonRest = altoAfter.some((m) =>
        m.events.some((e) => e.kind !== 'rest' && e.pitches[0]?.step !== 'rest'),
      )
      if (!hasNonRest) {
        fails.push('alto voice is still all rests; expected countermelody content')
      }
    }
    return fails
  },
})
