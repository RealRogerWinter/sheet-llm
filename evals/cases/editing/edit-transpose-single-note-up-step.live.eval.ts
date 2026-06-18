import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Transpose probe: raise one specific note a diatonic step via
 * edit_intra_measure + changePitch. Untouched bars must survive verbatim
 * (per-measure hash). Bar 2 (index 1) event index 2 is B4; raising one
 * diatonic step in C major yields C5.
 */
const INITIAL: Score = {
  title: 'Transpose probe',
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
    {
      events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'half' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
      ],
    },
  ],
}

buildLiveCase({
  id: 'edit-transpose-single-note-up-step',
  title: 'editing: raise the third note of bar 2 one step (changePitch)',
  initialScore: INITIAL,
  userText: 'Raise the third note of bar 2 up one step.',
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Transpose probe',
    measureCount: 3,
    firstNMeasuresIdentical: 1,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (!(result.appliedOps ?? []).some((o) => o.kind === 'changePitch')) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain changePitch, got [${got}]`)
    }
    const target = result.score.measures[1]?.events[2]?.pitches[0]
    if (!target || target.step !== 'C' || target.octave !== 5) {
      fails.push(
        `expected bar 2 event 3 raised B4 -> C5; got ${target ? `${target.step}${target.octave}` : '<missing>'}`,
      )
    }
    if (hashMeasure(result.score.measures[2]) !== hashMeasure(INITIAL.measures[2])) {
      fails.push('bar 3 (index 2) must be untouched')
    }
    return fails
  },
})
