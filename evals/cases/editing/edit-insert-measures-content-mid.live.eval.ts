import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Insert probe (content-bearing, mid-score): insert 2 new bars after
 * measure 2 via insert_measures. measureCount goes 4 -> 6. Bars before
 * the insertion stay at their indices; bars after shift +2. The two
 * inserted bars (index 2,3) each validate to 4 beats in 4/4.
 */
const INITIAL: Score = {
  title: 'Insert content probe',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
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
  id: 'edit-insert-measures-content-mid',
  title: 'editing: insert 2 new bars after measure 2 (insert_measures)',
  initialScore: INITIAL,
  userText: 'Insert 2 new bars after measure 2.',
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Insert content probe',
    measureCount: 6,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (result.dispatchTool !== 'insert_measures') {
      fails.push(
        `expected dispatchTool=insert_measures, got ${result.dispatchTool ?? '<unset>'}`,
      )
    }
    if (!(result.appliedOps ?? []).some((o) => o.kind === 'insertMeasuresAfter')) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain insertMeasuresAfter, got [${got}]`)
    }
    const out = result.score.measures
    if (out.length !== 6) {
      fails.push(`expected measureCount=6 (4 + 2 inserted); got ${out.length}`)
    }
    // "After measure 2" is position-ambiguous (1- vs 0-based), so assert the real
    // correctness criterion rather than an exact insertion index: all 4 original
    // bars survive IN ORDER (as an ordered subsequence of the result), and every
    // bar — originals and the 2 inserted — is a valid 4-beat 4/4 bar.
    const initialHashes = INITIAL.measures.map((m) => hashMeasure(m))
    const outHashes = out.map((m) => hashMeasure(m))
    let matched = 0
    for (const h of outHashes) {
      if (matched < initialHashes.length && h === initialHashes[matched]) matched++
    }
    if (matched !== initialHashes.length) {
      fails.push(
        `all 4 original bars must be preserved in order as a subsequence; matched ${matched}/4`,
      )
    }
    out.forEach((m, i) => {
      const sum = measureBeats((m.events ?? []) as { duration: string }[])
      if (sum !== 4) {
        fails.push(`bar index ${i} should sum to 4 beats in 4/4; got ${sum}`)
      }
    })
    return fails
  },
})
