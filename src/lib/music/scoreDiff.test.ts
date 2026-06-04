import { describe, expect, it } from 'vitest'
import { DIFF_ALGO_VERSION, computeAffectedEventIds, scoreDiff } from './scoreDiff'
import type { Event, Measure, Score } from './types'

function makeNote(step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', octave = 4): Event {
  return {
    kind: 'note',
    pitches: [{ step, octave }],
    duration: 'quarter',
  }
}

function makeRest(): Event {
  return {
    kind: 'rest',
    pitches: [{ step: 'rest', octave: 4 }],
    duration: 'whole',
  }
}

function makeMeasure(events: Event[]): Measure {
  return { events }
}

function makeScore(opts: {
  measures: Measure[]
  key?: Score['key']
  meter?: Score['meter']
  title?: string
  secondStaffMeasures?: Measure[]
  extraVoiceMeasures?: Measure[]
}): Score {
  const score: Score = {
    key: opts.key ?? 'C',
    meter: opts.meter ?? '4/4',
    measures: opts.measures,
  }
  if (opts.title !== undefined) score.title = opts.title
  if (opts.secondStaffMeasures) {
    score.secondStaff = { clef: 'bass', measures: opts.secondStaffMeasures }
  }
  if (opts.extraVoiceMeasures) {
    score.extraVoices = [{ measures: opts.extraVoiceMeasures }]
  }
  return score
}

describe('DIFF_ALGO_VERSION', () => {
  it('is currently 2', () => {
    expect(DIFF_ALGO_VERSION).toBe(2)
  })
})

describe('scoreDiff — counts + booleans', () => {
  it('identical scores → retention 1.0, all booleans false', () => {
    const m1 = makeMeasure([makeNote('C'), makeNote('D')])
    const m2 = makeMeasure([makeNote('E')])
    const before = makeScore({ measures: [m1, m2] })
    const after = makeScore({ measures: [m1, m2] })
    const d = scoreDiff(before, after)
    expect(d.measureCountBefore).toBe(2)
    expect(d.measureCountAfter).toBe(2)
    expect(d.keyChanged).toBe(false)
    expect(d.meterChanged).toBe(false)
    expect(d.titleChanged).toBe(false)
    expect(d.retainedEventRatio).toBe(1)
  })

  it('appended bars → retention 1.0 (the M3.5 happy path)', () => {
    const m = makeMeasure([makeNote('C')])
    const before = makeScore({ measures: [m, m, m, m] })
    const after = makeScore({ measures: [m, m, m, m, m, m, m, m] })
    const d = scoreDiff(before, after)
    expect(d.measureCountBefore).toBe(4)
    expect(d.measureCountAfter).toBe(8)
    expect(d.retainedEventRatio).toBe(1)
  })

  it('key change → keyChanged=true', () => {
    const m = makeMeasure([makeRest()])
    const before = makeScore({ measures: [m], key: 'C' })
    const after = makeScore({ measures: [m], key: 'G' })
    const d = scoreDiff(before, after)
    expect(d.keyChanged).toBe(true)
    expect(d.meterChanged).toBe(false)
  })

  it('meter change → meterChanged=true', () => {
    const m = makeMeasure([makeRest()])
    const before = makeScore({ measures: [m], meter: '4/4' })
    const after = makeScore({ measures: [m], meter: '3/4' })
    expect(scoreDiff(before, after).meterChanged).toBe(true)
  })

  it('title change → titleChanged=true (including undefined → set)', () => {
    const m = makeMeasure([makeRest()])
    const before = makeScore({ measures: [m] })
    const after = makeScore({ measures: [m], title: 'New Piece' })
    expect(scoreDiff(before, after).titleChanged).toBe(true)
  })

  it('title same → titleChanged=false', () => {
    const m = makeMeasure([makeRest()])
    const a = makeScore({ measures: [m], title: 'x' })
    const b = makeScore({ measures: [m], title: 'x' })
    expect(scoreDiff(a, b).titleChanged).toBe(false)
  })
})

describe('scoreDiff — measure-identity retention', () => {
  it('partial mutation in m2 → ratio reflects one measure failed identity', () => {
    const m1 = makeMeasure([makeNote('C')])
    const m2 = makeMeasure([makeNote('D')])
    const m2Mutated = makeMeasure([makeNote('E')])
    const before = makeScore({ measures: [m1, m2] })
    const after = makeScore({ measures: [m1, m2Mutated] })
    const d = scoreDiff(before, after)
    expect(d.retainedEventRatio).toBe(0.5) // 1 of 2 measures retained
  })

  it('wholesale replacement → ratio near 0', () => {
    const before = makeScore({
      measures: [makeMeasure([makeNote('C')]), makeMeasure([makeNote('D')])],
    })
    const after = makeScore({
      measures: [makeMeasure([makeNote('A')]), makeMeasure([makeNote('B')])],
    })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(0)
  })

  it('ratio uses overlap min(beforeLen, afterLen) but divides by beforeLen', () => {
    // Truncation: 4 bars → 2 bars, both retained
    const m = makeMeasure([makeNote('C')])
    const before = makeScore({ measures: [m, m, m, m] })
    const after = makeScore({ measures: [m, m] })
    const d = scoreDiff(before, after)
    expect(d.measureCountBefore).toBe(4)
    expect(d.measureCountAfter).toBe(2)
    expect(d.retainedEventRatio).toBe(0.5) // 2/4
  })

  it('articulations affect identity hash', () => {
    const plain = makeNote('C')
    const accented: Event = { ...plain, articulations: ['accent'] }
    const before = makeScore({ measures: [makeMeasure([plain])] })
    const after = makeScore({ measures: [makeMeasure([accented])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(0)
  })

  it('articulation order does not affect identity hash', () => {
    const a: Event = { ...makeNote('C'), articulations: ['accent', 'staccato'] }
    const b: Event = { ...makeNote('C'), articulations: ['staccato', 'accent'] }
    const before = makeScore({ measures: [makeMeasure([a])] })
    const after = makeScore({ measures: [makeMeasure([b])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(1)
  })
})

describe('scoreDiff — missing sides', () => {
  it('missing before → ratio null + change flags null', () => {
    const after = makeScore({ measures: [makeMeasure([makeRest()])] })
    const d = scoreDiff(undefined, after)
    expect(d.retainedEventRatio).toBeNull()
    expect(d.measureCountBefore).toBe(0)
    expect(d.measureCountAfter).toBe(1)
    // With no before to compare against, "did it change?" is undefined,
    // not false — writing false would lie about preservation.
    expect(d.keyChanged).toBeNull()
    expect(d.meterChanged).toBeNull()
    expect(d.titleChanged).toBeNull()
  })

  it('missing after → ratio null + change flags null', () => {
    const before = makeScore({ measures: [makeMeasure([makeRest()])] })
    const d = scoreDiff(before, undefined)
    expect(d.retainedEventRatio).toBeNull()
    expect(d.keyChanged).toBeNull()
    expect(d.meterChanged).toBeNull()
    expect(d.titleChanged).toBeNull()
  })

  it('both missing → ratio null + change flags null + counts zero', () => {
    const d = scoreDiff(undefined, undefined)
    expect(d.retainedEventRatio).toBeNull()
    expect(d.measureCountBefore).toBe(0)
    expect(d.voiceCountBefore).toBe(0)
    expect(d.keyChanged).toBeNull()
    expect(d.meterChanged).toBeNull()
    expect(d.titleChanged).toBeNull()
  })

  it('empty before (0 measures) → ratio null', () => {
    const before = makeScore({ measures: [] })
    const after = makeScore({ measures: [makeMeasure([makeRest()])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBeNull()
  })
})

describe('scoreDiff — DIFF_ALGO_VERSION=2 fields (ties / lyrics / tuplet / fingerings / chord_symbol)', () => {
  it('event-level tied_to_next affects identity hash', () => {
    const plain = makeNote('C')
    const tied: Event = { ...plain, tied_to_next: true }
    const before = makeScore({ measures: [makeMeasure([plain])] })
    const after = makeScore({ measures: [makeMeasure([tied])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(0)
  })

  it('per-pitch tied_to_next affects identity hash', () => {
    const plain: Event = {
      kind: 'note',
      pitches: [{ step: 'C', octave: 4 }],
      duration: 'quarter',
    }
    const tied: Event = {
      kind: 'note',
      pitches: [{ step: 'C', octave: 4, tied_to_next: true }],
      duration: 'quarter',
    }
    const before = makeScore({ measures: [makeMeasure([plain])] })
    const after = makeScore({ measures: [makeMeasure([tied])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(0)
  })

  it('tuplet affects identity hash', () => {
    const plain = makeNote('C')
    const triplet: Event = { ...plain, tuplet: 3 }
    const before = makeScore({ measures: [makeMeasure([plain])] })
    const after = makeScore({ measures: [makeMeasure([triplet])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(0)
  })

  it('lyrics affect identity hash; verse order does not', () => {
    const noLyrics = makeNote('C')
    const withLyrics: Event = {
      ...noLyrics,
      lyrics: [
        { verse: 1, syllable: 'Hal' },
        { verse: 2, syllable: 'Lord' },
      ],
    }
    const withLyricsReversed: Event = {
      ...noLyrics,
      lyrics: [
        { verse: 2, syllable: 'Lord' },
        { verse: 1, syllable: 'Hal' },
      ],
    }
    // Adding lyrics changes the hash.
    expect(
      scoreDiff(
        makeScore({ measures: [makeMeasure([noLyrics])] }),
        makeScore({ measures: [makeMeasure([withLyrics])] }),
      ).retainedEventRatio,
    ).toBe(0)
    // Reordering verses does NOT change the hash.
    expect(
      scoreDiff(
        makeScore({ measures: [makeMeasure([withLyrics])] }),
        makeScore({ measures: [makeMeasure([withLyricsReversed])] }),
      ).retainedEventRatio,
    ).toBe(1)
  })

  it('fingerings affect identity hash', () => {
    const plain = makeNote('C')
    const fingered: Event = {
      ...plain,
      fingerings: [{ system: 'piano', value: '3' }],
    }
    const before = makeScore({ measures: [makeMeasure([plain])] })
    const after = makeScore({ measures: [makeMeasure([fingered])] })
    expect(scoreDiff(before, after).retainedEventRatio).toBe(0)
  })

  it('chordSymbol affects identity hash', () => {
    const plain = makeNote('C')
    const harmony: Event = {
      ...plain,
      chordSymbol: { root: 'C', quality: 'major', seventh: 'none', display: 'C' },
    }
    const harmonyG: Event = {
      ...plain,
      chordSymbol: { root: 'G', quality: 'major', seventh: 'none', display: 'G' },
    }
    expect(
      scoreDiff(
        makeScore({ measures: [makeMeasure([plain])] }),
        makeScore({ measures: [makeMeasure([harmony])] }),
      ).retainedEventRatio,
    ).toBe(0)
    expect(
      scoreDiff(
        makeScore({ measures: [makeMeasure([harmony])] }),
        makeScore({ measures: [makeMeasure([harmonyG])] }),
      ).retainedEventRatio,
    ).toBe(0)
  })
})

describe('scoreDiff — multi-staff and multi-voice', () => {
  it('two-staff score reports voiceCount sum across staves', () => {
    const m = makeMeasure([makeRest()])
    const before = makeScore({ measures: [m], secondStaffMeasures: [m] })
    const after = makeScore({ measures: [m], secondStaffMeasures: [m] })
    const d = scoreDiff(before, after)
    expect(d.voiceCountBefore).toBe(2) // 1 voice per staff × 2 staves
    expect(d.voiceCountAfter).toBe(2)
  })

  it('multi-voice on primary staff counts each voice', () => {
    const m = makeMeasure([makeRest()])
    const before = makeScore({ measures: [m], extraVoiceMeasures: [m] })
    expect(scoreDiff(before, before).voiceCountBefore).toBe(2)
  })

  it('voice count fanout: adding a second staff bumps the count', () => {
    const m = makeMeasure([makeRest()])
    const before = makeScore({ measures: [m] })
    const after = makeScore({ measures: [m], secondStaffMeasures: [m] })
    const d = scoreDiff(before, after)
    expect(d.voiceCountBefore).toBe(1)
    expect(d.voiceCountAfter).toBe(2)
  })
})

describe('computeAffectedEventIds (M24-PR-2)', () => {
  function makeIded(id: string, ev: Event): Event {
    return { ...ev, id }
  }

  it('identical scores → empty list', () => {
    const m = makeMeasure([makeIded('e0', makeNote('C')), makeIded('e1', makeNote('D'))])
    const before = makeScore({ measures: [m] })
    const after = makeScore({ measures: [m] })
    expect(computeAffectedEventIds(before, after)).toEqual([])
  })

  it('single pitch change → 1 affected id (from the AFTER side)', () => {
    const before = makeScore({
      measures: [
        makeMeasure([
          makeIded('e0', makeNote('C')),
          makeIded('e1', makeNote('D')),
          makeIded('e2', makeNote('E')),
        ]),
      ],
    })
    const after = makeScore({
      measures: [
        makeMeasure([
          makeIded('e0', makeNote('C')),
          makeIded('e1', makeNote('E')), // D -> E
          makeIded('e2', makeNote('E')),
        ]),
      ],
    })
    expect(computeAffectedEventIds(before, after)).toEqual(['e1'])
  })

  it('inserted events at end of measure → their ids appear', () => {
    const before = makeScore({
      measures: [makeMeasure([makeIded('e0', makeNote('C'))])],
    })
    const after = makeScore({
      measures: [
        makeMeasure([
          makeIded('e0', makeNote('C')),
          makeIded('e1', makeNote('D')),
          makeIded('e2', makeNote('E')),
        ]),
      ],
    })
    expect(computeAffectedEventIds(before, after)).toEqual(['e1', 'e2'])
  })

  it('inserted measure → every event id contributes', () => {
    const before = makeScore({
      measures: [makeMeasure([makeIded('e0', makeNote('C'))])],
    })
    const after = makeScore({
      measures: [
        makeMeasure([makeIded('e0', makeNote('C'))]),
        makeMeasure([
          makeIded('e1', makeNote('D')),
          makeIded('e2', makeNote('E')),
        ]),
      ],
    })
    expect(computeAffectedEventIds(before, after)).toEqual(['e1', 'e2'])
  })

  it('deleted events → no contribution (no after-side id)', () => {
    const before = makeScore({
      measures: [
        makeMeasure([
          makeIded('e0', makeNote('C')),
          makeIded('e1', makeNote('D')),
          makeIded('e2', makeNote('E')),
        ]),
      ],
    })
    const after = makeScore({
      measures: [makeMeasure([makeIded('e0', makeNote('C'))])],
    })
    expect(computeAffectedEventIds(before, after)).toEqual([])
  })

  it('events without ids are silently skipped (no stable handle)', () => {
    const before = makeScore({
      measures: [makeMeasure([makeNote('C'), makeNote('D')])],
    })
    const after = makeScore({
      measures: [makeMeasure([makeNote('C'), makeNote('E')])],
    })
    expect(computeAffectedEventIds(before, after)).toEqual([])
  })

  it('measure-level hash short-circuit: same measure is skipped without per-event walk', () => {
    // Verify retention optimization — measures with matching hashes
    // never get their per-event canonical forms recomputed.
    const m0 = makeMeasure([makeIded('e0', makeNote('C'))])
    const m1Before = makeMeasure([makeIded('e1', makeNote('D'))])
    const m1After = makeMeasure([makeIded('e1', makeNote('E'))])
    const before = makeScore({ measures: [m0, m1Before] })
    const after = makeScore({ measures: [m0, m1After] })
    // Only m1 differs; e1 surfaces.
    expect(computeAffectedEventIds(before, after)).toEqual(['e1'])
  })

  it('key change with no event-content diff → empty list (caller handles structural diff separately)', () => {
    // computeAffectedEventIds only walks events. Key/meter/title
    // changes are detected by scoreDiff; the orchestrator combines
    // both signals to decide whether to emit a proposal at all.
    const m = makeMeasure([makeIded('e0', makeNote('C'))])
    const before = makeScore({ measures: [m], key: 'C' })
    const after = makeScore({ measures: [m], key: 'G' })
    expect(computeAffectedEventIds(before, after)).toEqual([])
  })
})
