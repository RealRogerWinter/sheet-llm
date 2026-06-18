import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * Lyric probe: add 'A-ma-zing grace' across the first four notes via
 * edit_intra_measure + setLyric (verse 1). Each of the first four events
 * gains a verse-1 lyric; concatenating the (lowercased, hyphen-stripped)
 * syllables reconstructs 'amazinggrace'. Pitches+durations unchanged;
 * bar 2 verbatim.
 */
const INITIAL: Score = {
  title: 'Lyric probe',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'E', octave: 5 }], duration: 'half' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'half' },
      ],
    },
  ],
}

function pitchDurKey(ev: {
  duration: string
  pitches: { step: string; octave: number; accidental?: string }[]
}): string {
  return (
    ev.duration +
    ':' +
    ev.pitches.map((p) => `${p.step}${p.octave}${p.accidental ?? ''}`).join('+')
  )
}

buildLiveCase({
  id: 'edit-add-lyrics-first-four-notes',
  title: 'editing: add lyrics "A-ma-zing grace" to the first four notes (setLyric)',
  initialScore: INITIAL,
  userText: "Add the lyrics 'A-ma-zing grace' to the first four notes.",
  expected: {
    keyPreserved: 'C',
    meterPreserved: '4/4',
    titlePreserved: 'Lyric probe',
    measureCount: 2,
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    if (!(result.appliedOps ?? []).some((o) => o.kind === 'setLyric')) {
      const got = (result.appliedOps ?? []).map((o) => o.kind).join(',') || '<none>'
      fails.push(`expected appliedOps to contain setLyric, got [${got}]`)
    }
    const bar1 = result.score.measures[0]?.events ?? []
    let collected = ''
    for (let i = 0; i < 4; i++) {
      const ev = bar1[i]
      const v1 = (ev?.lyrics ?? []).find((l) => l.verse === 1)
      if (!v1 || !v1.syllable || v1.syllable.length === 0) {
        fails.push(`expected event ${i + 1} to carry a non-empty verse-1 lyric`)
      } else {
        collected += v1.syllable.toLowerCase().replace(/-/g, '')
      }
    }
    if (collected !== 'amazinggrace') {
      fails.push(
        `expected concatenated syllables to reconstruct 'amazinggrace'; got '${collected}'`,
      )
    }
    // Pitches + durations of all bar 1 events unchanged (lyrics added only).
    INITIAL.measures[0].events.forEach((init, i) => {
      const after = bar1[i]
      if (!after || pitchDurKey(after) !== pitchDurKey(init)) {
        fails.push(`bar 1 event ${i + 1} pitch/duration changed (expected preserved)`)
      }
    })
    if (hashMeasure(result.score.measures[1]) !== hashMeasure(INITIAL.measures[1])) {
      fails.push('bar 2 (index 1) must be untouched')
    }
    return fails
  },
})
