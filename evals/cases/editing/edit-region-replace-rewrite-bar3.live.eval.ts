import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Region-replace probe: rewrite a single specific bar via region_replace.
 * Range size 1 replaced by 1, so measureCount stays 4. Bars outside the
 * region (0,1,3) preserved by per-measure hash; bar 3 (index 2) must
 * actually change and remain valid (4 beats) in 4/4.
 */
const INITIAL: Score = {
  title: 'Region replace probe',
  key: 'D',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'A', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }] },
  ],
}

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
  id: 'edit-region-replace-rewrite-bar3',
  title: 'editing: rewrite bar 3 (region_replace, single bar)',
  initialScore: INITIAL,
  userText: 'Rewrite bar 3 with a more interesting melody, keeping it in the same key and meter.',
  expected: {
    keyPreserved: 'D',
    meterPreserved: '4/4',
    titlePreserved: 'Region replace probe',
    measureCount: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'region_replace') {
      fails.push(
        `expected dispatchTool=region_replace, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    if (!(result.appliedOps ?? []).some((o) => o.kind === 'regionReplace')) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain regionReplace, got [${got}]`)
    }
    if (result.score.measures.length !== 4) {
      fails.push(
        `expected measureCount to stay 4 (range size 1 replaced by 1); got ${result.score.measures.length}`,
      )
    }
    for (const i of [0, 1, 3]) {
      if (
        result.score.measures[i] === undefined ||
        hashMeasure(result.score.measures[i]) !== hashMeasure(INITIAL.measures[i])
      ) {
        fails.push(`bar index ${i} (outside region) must be preserved`)
      }
    }
    if (
      result.score.measures[2] !== undefined &&
      hashMeasure(result.score.measures[2]) === hashMeasure(INITIAL.measures[2])
    ) {
      fails.push('bar 3 (index 2) must actually be rewritten (differ from original)')
    }
    const sum = measureBeats(
      (result.score.measures[2]?.events ?? []) as { duration: string }[],
    )
    if (sum !== 4) {
      fails.push(`expected rewritten bar 3 to sum to 4 beats in 4/4; got ${sum}`)
    }
    return fails
  },
})
