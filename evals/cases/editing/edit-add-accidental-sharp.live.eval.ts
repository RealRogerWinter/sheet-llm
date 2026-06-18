import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Accidental probe: sharpen the (only) F via edit_intra_measure +
 * setAccidental. The pitch gains accidental:'sharp' but stays step F;
 * everything else byte-identical. Bar 3 (index 2) must survive verbatim.
 */
const INITIAL: Score = {
  title: 'Accidental probe',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
      ],
    },
    {
      events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }],
    },
  ],
}

buildLiveCase({
  id: 'edit-add-accidental-sharp',
  title: 'editing: sharpen the F in bar 2 (setAccidental)',
  initialScore: INITIAL,
  userText: 'Sharpen the F in bar 2.',
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Accidental probe',
    measureCount: 3,
    firstNMeasuresIdentical: 1,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (!(result.appliedOps ?? []).some((o) => o.kind === 'setAccidental')) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain setAccidental, got [${got}]`)
    }
    const target = result.score.measures[1]?.events[0]?.pitches[0]
    if (!target || target.accidental !== 'sharp') {
      fails.push(
        `expected bar 2 event 1 accidental=sharp; got ${target?.accidental ?? '<none>'}`,
      )
    }
    if (target && (target.step !== 'F' || target.octave !== 4)) {
      fails.push(
        `expected the sharpened pitch to remain F4 (raised by accidental, not changePitch); got ${target.step}${target.octave}`,
      )
    }
    if (hashMeasure(result.score.measures[2]) !== hashMeasure(INITIAL.measures[2])) {
      fails.push('bar 3 (index 2) must be untouched')
    }
    return fails
  },
})
