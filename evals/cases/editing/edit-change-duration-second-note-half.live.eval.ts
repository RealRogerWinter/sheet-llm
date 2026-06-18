import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Duration probe (deterministic): in bar 1, make the first note a whole
 * note and remove the second note via edit_intra_measure (changeDuration
 * + deleteEvent). Bar 1 starts as two half notes (2+2=4 beats, valid) and
 * must end as a single whole note (4 beats, valid). Bar 2 (index 1) must
 * survive verbatim. This avoids the ambiguous reflow of the earlier
 * "make the second note a half note" phrasing, which forced an invalid bar.
 */
const INITIAL: Score = {
  title: 'Duration probe',
  key: 'G',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
      ],
    },
    {
      events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }],
    },
  ],
}

/** Coarse beat-equivalent value of each duration token. */
function durationBeats(d: string): number {
  switch (d) {
    case 'whole':
      return 4
    case 'dotted-half':
      return 3
    case 'half':
      return 2
    case 'dotted-quarter':
      return 1.5
    case 'quarter':
      return 1
    case 'dotted-eighth':
      return 0.75
    case 'eighth':
      return 0.5
    case 'sixteenth':
      return 0.25
    case 'thirty-second':
      return 0.125
    case 'breve':
      return 8
    case 'sixty-fourth':
      return 0.0625
    default:
      return 0
  }
}

function measureBeats(events: { duration: string }[]): number {
  return events.reduce((s, e) => s + durationBeats(e.duration), 0)
}

buildLiveCase({
  id: 'edit-change-duration-second-note-half',
  title: 'editing: make bar 1 the first note a whole note, remove the second (changeDuration)',
  initialScore: INITIAL,
  userText: 'In bar 1, make the first note a whole note and remove the second note.',
  expected: {
    keyPreserved: 'G',
    meterPreserved: '4/4',
    titlePreserved: 'Duration probe',
    measureCount: 2,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (!(result.appliedOps ?? []).some((o) => o.kind === 'changeDuration')) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain changeDuration, got [${got}]`)
    }
    const bar1 = result.score.measures[0]?.events ?? []
    if (bar1.length !== 1) {
      fails.push(`expected bar 1 to have exactly 1 event after the edit; got ${bar1.length}`)
    }
    const first = bar1[0]
    if (!first || first.duration !== 'whole') {
      fails.push(`expected bar 1 event 1 duration=whole; got ${first?.duration ?? '<missing>'}`)
    }
    const firstPitch = first?.pitches[0]
    if (!firstPitch || firstPitch.step !== 'G' || firstPitch.octave !== 4) {
      fails.push(
        `expected bar 1 event 1 to remain G4; got ${firstPitch ? `${firstPitch.step}${firstPitch.octave}` : '<missing>'}`,
      )
    }
    const sum = measureBeats(bar1 as { duration: string }[])
    if (sum !== 4) {
      fails.push(`expected bar 1 to still sum to 4 beats in 4/4; got ${sum}`)
    }
    if (hashMeasure(result.score.measures[1]) !== hashMeasure(INITIAL.measures[1])) {
      fails.push('bar 2 (index 1) must be untouched')
    }
    return fails
  },
})
