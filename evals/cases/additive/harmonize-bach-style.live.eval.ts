import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Bach-style chorale harmonization. 4-bar monophonic F-major soprano
 * line. User: "harmonize this in 4 voices like a Bach chorale".
 *
 * Defensible outcomes:
 *  - dispatched to edit_intra_measure: alto added to extraVoices,
 *    secondStaff added with tenor + bass; soprano preserved on
 *    primary measures.
 *  - dispatched to regenerate_all with confirmExplicitRewrite=true
 *    (user explicitly asked for full 4-voice harmonization).
 *
 * We assert soprano preservation (firstNMeasuresIdentical=4 on the
 * primary measures) AND that the result is 4 voices total (primary
 * + alto in extraVoices + tenor + bass on secondStaff).
 */
const F_MELODY: Score = {
  title: 'Bach chorale subject',
  key: 'F',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'F', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 5 }], duration: 'half' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'B', octave: 5, accidental: 'flat' }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 5 }], duration: 'half' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'F', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'F', octave: 5 }], duration: 'half' },
        { pitches: [{ step: 'F', octave: 5 }], duration: 'half' },
      ],
    },
  ],
}

buildLiveCase({
  id: 'harmonize-bach-style',
  title: 'additive: 4-voice Bach chorale harmonization',
  initialScore: F_MELODY,
  userText: 'harmonize this in 4 voices like a Bach chorale',
  expensive: true,
  expected: {
    measureCount: 4,
    keyPreserved: 'F',
    meterPreserved: '4/4',
    titlePreserved: 'Bach chorale subject',
    // Soprano (primary voice on primary staff) should remain
    // byte-identical even after harmonization.
    firstNMeasuresIdentical: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    const score = result.score
    // Count voices: primary (1) + extraVoices (alto) + secondStaff
    // primary (tenor) + secondStaff.extraVoices[0] (bass).
    const primaryVoices = 1 + (score.extraVoices?.length ?? 0)
    const secondStaffVoices = score.secondStaff
      ? 1 + (score.secondStaff.extraVoices?.length ?? 0)
      : 0
    const totalVoices = primaryVoices + secondStaffVoices
    if (totalVoices < 4) {
      fails.push(
        `expected 4 voices (SATB) total; got ${totalVoices} (primary=${primaryVoices}, secondStaff=${secondStaffVoices})`,
      )
    }
    // Record (not assert) which dispatch tool was picked — both are
    // defensible.
    if (
      result.dispatchTool !== 'edit_intra_measure' &&
      result.dispatchTool !== 'regenerate_all'
    ) {
      fails.push(
        `expected dispatchTool ∈ {edit_intra_measure, regenerate_all}; got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    return fails
  },
})
