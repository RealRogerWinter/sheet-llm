import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Region-replace probe (multi-bar enrich): add a bass line under bars
 * 2-3 via region_replace (NOT insert/extend). Range size 2 replaced by 2,
 * so measureCount stays 4. Outer bars (0,3) preserved verbatim. The added
 * bass lands in the multi-voice perVoiceContent/voices structure rather
 * than the flattened `result.score.measures`, so we verify the edit
 * structurally: a regionReplace op spanning the requested region, plus
 * verbatim preservation of the bars outside it.
 */
const INITIAL: Score = {
  title: 'Bassline range probe',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'E', octave: 5 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 5 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'G', octave: 5 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 5 }], duration: 'whole' }] },
  ],
}

buildLiveCase({
  id: 'edit-region-replace-add-bassline-range',
  title: 'editing: add a bass line under bars 2-3 (region_replace, multi-bar)',
  initialScore: INITIAL,
  userText: 'Add a bass line under bars 2 through 3.',
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Bassline range probe',
    measureCount: 4,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'region_replace') {
      fails.push(
        `expected dispatchTool=region_replace, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    const regionOp = (result.appliedOps ?? []).find((o) => o.kind === 'regionReplace')
    if (!regionOp) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain regionReplace, got [${got}]`)
    } else {
      // "bars 2 through 3" → 0-based indices 1..2.
      const start = (regionOp as { startMeasureIdx?: number }).startMeasureIdx
      const end = (regionOp as { endMeasureIdx?: number }).endMeasureIdx
      if (typeof start !== 'number' || typeof end !== 'number' || end < start) {
        fails.push(
          `expected regionReplace to expose a valid [startMeasureIdx..endMeasureIdx]; got [${start}..${end}]`,
        )
      } else if (start !== 1 || end !== 2) {
        fails.push(
          `expected regionReplace to target bars 2-3 (indices 1..2); got [${start}..${end}]`,
        )
      }
    }
    if (result.score.measures.length !== 4) {
      fails.push(
        `expected measureCount to stay 4 (2 bars replaced by 2); got ${result.score.measures.length}`,
      )
    }
    // Outer bars (0, 3) must be byte-identical.
    for (const i of [0, 3]) {
      if (
        result.score.measures[i] === undefined ||
        hashMeasure(result.score.measures[i]) !== hashMeasure(INITIAL.measures[i])
      ) {
        fails.push(`outer bar index ${i} must be preserved verbatim`)
      }
    }
    return fails
  },
})
