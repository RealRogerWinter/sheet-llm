import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Dynamic probe: put mf on the downbeat of bar 1 via edit_intra_measure +
 * setDynamic. The first event of bar 1 gains dynamic:'mf' (or
 * dynamic_structured.base==='mf'); pitches unchanged; bar 2 verbatim.
 * 3/4 meter: bar 1 = 3 quarters, bar 2 = dotted-half (both 3 beats).
 */
const INITIAL: Score = {
  title: 'Dynamic probe',
  key: 'F',
  meter: '3/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'dotted-half' }],
    },
  ],
}

function pitchKey(ev: { pitches: { step: string; octave: number; accidental?: string }[] }): string {
  return ev.pitches
    .map((p) => `${p.step}${p.octave}${p.accidental ?? ''}`)
    .join('+')
}

buildLiveCase({
  id: 'edit-set-dynamic-mf-downbeat',
  title: 'editing: put an mf on the downbeat of bar 1 (setDynamic)',
  initialScore: INITIAL,
  userText: 'Put an mf on the downbeat of bar 1.',
  expected: {
    keyPreserved: 'F',
    meterPreserved: '3/4',
    titlePreserved: 'Dynamic probe',
    measureCount: 2,
    firstNMeasuresIdentical: 0,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    const ops = result.appliedOps ?? []
    if (!ops.some((o) => o.kind === 'setDynamic' || o.kind === 'setDynamicStructured')) {
      const got = ops.map((o) => o.kind).join(',') || '<none>'
      fails.push(
        `expected appliedOps to contain setDynamic or setDynamicStructured, got [${got}]`,
      )
    }
    const ev = result.score.measures[0]?.events[0]
    const base = ev?.dynamic ?? ev?.dynamic_structured?.base
    if (base !== 'mf') {
      fails.push(`expected bar 1 downbeat dynamic=mf; got ${base ?? '<none>'}`)
    }
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
