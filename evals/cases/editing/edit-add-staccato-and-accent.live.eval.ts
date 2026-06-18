import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Articulation probe: stack staccato + accent on the second note of bar 1
 * via edit_intra_measure + setArticulations. normalizeArticulations keeps
 * both (staccato+accent is allowed). Pitches unchanged; bar 2 verbatim.
 */
const INITIAL: Score = {
  title: 'Articulation probe',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }],
    },
  ],
}

/** Pitch-only comparison (ignores articulations/dynamics/lyrics). */
function pitchKey(ev: { pitches: { step: string; octave: number; accidental?: string }[] }): string {
  return ev.pitches
    .map((p) => `${p.step}${p.octave}${p.accidental ?? ''}`)
    .join('+')
}

buildLiveCase({
  id: 'edit-add-staccato-and-accent',
  title: 'editing: add staccato + accent to the second note of bar 1 (setArticulations)',
  initialScore: INITIAL,
  userText: 'Add staccato and an accent to the second note of bar 1.',
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Articulation probe',
    measureCount: 2,
    firstNMeasuresIdentical: 0,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    const ops = result.appliedOps ?? []
    if (!ops.some((o) => o.kind === 'setArticulations' || o.kind === 'setArticulation')) {
      const got = ops.map((o) => o.kind).join(',') || '<none>'
      fails.push(
        `expected appliedOps to contain setArticulations or setArticulation, got [${got}]`,
      )
    }
    const ev = result.score.measures[0]?.events[1]
    const arts = new Set(ev?.articulations ?? [])
    if (!arts.has('staccato') || !arts.has('accent')) {
      fails.push(
        `expected bar 1 event 2 to have both staccato and accent; got [${[...arts].join(',') || '<none>'}]`,
      )
    }
    // Pitches of every event in bar 1 unchanged.
    const afterBar1 = result.score.measures[0]?.events ?? []
    INITIAL.measures[0].events.forEach((init, i) => {
      const after = afterBar1[i]
      if (!after || pitchKey(after) !== pitchKey(init)) {
        fails.push(`bar 1 event ${i + 1} pitch changed (expected pitches preserved)`)
      }
    })
    if (hashMeasure(result.score.measures[1]) !== hashMeasure(INITIAL.measures[1])) {
      fails.push('bar 2 (index 1) must be untouched')
    }
    return fails
  },
})
