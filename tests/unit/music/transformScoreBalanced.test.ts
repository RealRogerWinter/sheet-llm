import { describe, it, expect } from 'vitest'
import {
  transformScoreBalanced,
  type BalancedOp,
} from '@/lib/music/transformScoreBalanced'
import { BalanceError } from '@/lib/music/measureBalance'
import { validateScore } from '@/lib/music/validateScore'
import type { Duration, Event, Score, Staff } from '@/lib/music/types'

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

function note(
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B',
  duration: Duration,
  extras: Partial<Event> = {},
): Event {
  return { pitches: [{ step, octave: 4 }], duration, ...extras }
}

function rest(duration: Duration, extras: Partial<Event> = {}): Event {
  return { pitches: [{ step: 'rest', octave: 4 }], duration, ...extras }
}

const FOUR_QUARTERS_4_4: Score = buildScore({
  measures: [{ events: [
    note('C', 'quarter'),
    note('D', 'quarter'),
    note('E', 'quarter'),
    note('F', 'quarter'),
  ] }],
})

const TWO_BARS_FOUR_QUARTERS: Score = buildScore({
  measures: [
    { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] },
    { events: [note('G', 'quarter'), note('A', 'quarter'), note('B', 'quarter'), note('C', 'quarter')] },
  ],
})

describe('reorderBalanced — within-measure', () => {
  it('reorders without changing measure total', () => {
    const out = transformScoreBalanced(FOUR_QUARTERS_4_4, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 0, position32nds: 32 }, // end of measure
    })
    const steps = out.measures[0].events.map((e) => e.pitches[0].step)
    expect(steps).toEqual(['D', 'E', 'F', 'C'])
    expect(() => validateScore(out)).not.toThrow()
  })

  it('snaps to nearest event boundary', () => {
    const out = transformScoreBalanced(FOUR_QUARTERS_4_4, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 0, position32nds: 13 }, // between 8 and 16, snaps to 16
    })
    const steps = out.measures[0].events.map((e) => e.pitches[0].step)
    expect(steps).toEqual(['D', 'C', 'E', 'F'])
  })

  it('blocks within-measure drops that fall inside a tuplet group', () => {
    const score: Score = buildScore({
      measures: [{ events: [
        note('C', 'half'),
        note('D', 'eighth', { tuplet: 3 }),
        note('E', 'eighth', { tuplet: 3 }),
        note('F', 'eighth', { tuplet: 3 }),
        note('G', 'quarter'),
      ] }],
    })
    // boundaries (non-tuplet-aware) = [0, 16, 20, 24, 28, 36]; position 20
    // snaps to boundary between D and E → both share tuplet 3 → blocked.
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 0 },
        target: { measureIdx: 0, position32nds: 20 },
      }),
    ).toThrow(BalanceError)
  })

  // ── tied_to_next handling on within-measure reorder ──────────────────
  // Same dangling-tie class as cross-measure, but for within-measure.
  // PR #61 fixed cross-measure; this fixture pins the within-measure fix.

  it('moved event LOSES tied_to_next on within-measure reorder', () => {
    // C-Q-TIED moves from front to end → its original tie target (D)
    // is no longer adjacent in the new layout, so the tie must strip.
    const src: Score = buildScore({
      measures: [{ events: [
        note('C', 'quarter', { tied_to_next: true }),
        note('D', 'quarter'),
        note('E', 'quarter'),
        note('F', 'quarter'),
      ] }],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 0, position32nds: 32 }, // end of measure
    })
    const events = out.measures[0].events
    expect(events.map((e) => e.pitches[0].step)).toEqual(['D', 'E', 'F', 'C'])
    expect(events[3].tied_to_next).toBeFalsy() // moved C has no dangling tie
    expect(() => validateScore(out)).not.toThrow()
  })

  it('ORIGINAL PREDECESSOR loses tied_to_next on within-measure reorder', () => {
    // C-Q, D-Q-TIED, E-Q, F-Q. D's tie pointed at E. Move E to the
    // front of the measure. D's "next" is now F (or some other event),
    // not E — strip the tie.
    const src: Score = buildScore({
      measures: [{ events: [
        note('C', 'quarter'),
        note('D', 'quarter', { tied_to_next: true }),
        note('E', 'quarter'),
        note('F', 'quarter'),
      ] }],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 2 }, // E
      target: { measureIdx: 0, position32nds: 0 }, // front
    })
    const events = out.measures[0].events
    expect(events.map((e) => e.pitches[0].step)).toEqual(['E', 'C', 'D', 'F'])
    // D is now at idx 2; its tied_to_next pointed at the moved E and
    // should be stripped.
    expect(events[2].pitches[0].step).toBe('D')
    expect(events[2].tied_to_next).toBeFalsy()
    expect(() => validateScore(out)).not.toThrow()
  })

  it('NEW PREDECESSOR loses tied_to_next when reorder displaces its original tie target', () => {
    // C-Q, D-Q-TIED, E-Q, F-Q. D's tie pointed at E. Move F to between
    // D and E (position 16). Now D's new "next" is F — strip.
    const src: Score = buildScore({
      measures: [{ events: [
        note('C', 'quarter'),
        note('D', 'quarter', { tied_to_next: true }),
        note('E', 'quarter'),
        note('F', 'quarter'),
      ] }],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 3 }, // F
      target: { measureIdx: 0, position32nds: 16 }, // between D and E
    })
    const events = out.measures[0].events
    expect(events.map((e) => e.pitches[0].step)).toEqual(['C', 'D', 'F', 'E'])
    // D at idx 1: its tied_to_next now points at F (different than the
    // original tie target E) — strip.
    expect(events[1].pitches[0].step).toBe('D')
    expect(events[1].tied_to_next).toBeFalsy()
    expect(() => validateScore(out)).not.toThrow()
  })

  it('identity within-measure reorder PRESERVES tied_to_next (no movement)', () => {
    // Drop at the same position → no movement; tie semantics unchanged.
    // originalIdx === srcEventIdx → insertIdx === srcEventIdx → identity.
    //
    // The successor at e1 is C (not D) so the event-wide tied_to_next
    // resolves to a valid target. M13-PR-2 tightened
    // validatePerPitchTies to honor event-wide ties via
    // isPitchTiedToNext — the pre-M13 fixture had C tied into a D
    // (broken target silently skipped); the M13 validator catches it.
    const src: Score = buildScore({
      measures: [{ events: [
        note('C', 'quarter', { tied_to_next: true }),
        note('C', 'quarter'),
        note('E', 'quarter'),
        note('F', 'quarter'),
      ] }],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 0, position32nds: 0 }, // same slot
    })
    const events = out.measures[0].events
    expect(events.map((e) => e.pitches[0].step)).toEqual(['C', 'C', 'E', 'F'])
    // Tie preserved on identity reorder.
    expect(events[0].tied_to_next).toBe(true)
    expect(() => validateScore(out)).not.toThrow()
  })
})

describe('reorderBalanced — cross-barline, no cascade', () => {
  it('right-drag (drop at front): source rest-fills, destination displaces front event', () => {
    const out = transformScoreBalanced(TWO_BARS_FOUR_QUARTERS, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 3 }, // F in m0
      target: { measureIdx: 1, position32nds: 0 }, // front of m1
    })
    const m0 = out.measures[0].events.map((e) => `${e.pitches[0].step}:${e.duration}`)
    const m1 = out.measures[1].events.map((e) => `${e.pitches[0].step}:${e.duration}`)
    expect(m0).toEqual(['C:quarter', 'D:quarter', 'E:quarter', 'rest:quarter'])
    // F displaces G at front of m1; m1 = F + (A, B, C) = 4 quarters
    expect(m1).toEqual(['F:quarter', 'A:quarter', 'B:quarter', 'C:quarter'])
    expect(() => validateScore(out)).not.toThrow()
  })

  it('left-drag (drop at end): source rest-fills, destination displaces back event', () => {
    const out = transformScoreBalanced(TWO_BARS_FOUR_QUARTERS, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 1, eventIdx: 0 }, // G in m1
      target: { measureIdx: 0, position32nds: 32 }, // end of m0
    })
    const m0 = out.measures[0].events.map((e) => `${e.pitches[0].step}:${e.duration}`)
    const m1 = out.measures[1].events.map((e) => `${e.pitches[0].step}:${e.duration}`)
    expect(m0).toEqual(['C:quarter', 'D:quarter', 'E:quarter', 'G:quarter'])
    expect(m0[3].split(':')[0]).toBe('G')
    expect(m1[0].split(':')[0]).toBe('rest')
    expect(() => validateScore(out)).not.toThrow()
  })

  it('overshoot inserts a rest filler', () => {
    // Source: m0 = [whole], m1 = [Q, Q, Q, Q]. Drag whole from m0 to front of m1.
    // No — m0 has only 1 event, would_empty_measure. Use a different setup.
    // Source m0 = [half, half]. m1 = [whole]. Drag first half from m0 to front of m1.
    // Wait whole = 32, drop replaces 32 → no overshoot.
    // Let's use: m1 = [whole], drag a quarter from m0 (which has [whole, ... wait])
    // Cleanest: m0 = [half=16, half=16]. m1 = [whole=32]. Drag first half (16u) into front of m1.
    // m1 consume from front: whole=32 (overshoots by 16). Rest of 16u fills.
    // m1 becomes [half(new), rest:half].
    const score: Score = buildScore({
      measures: [
        { events: [note('C', 'half'), note('D', 'half')] },
        { events: [note('E', 'whole')] },
      ],
    })
    const out = transformScoreBalanced(score, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    const m1 = out.measures[1].events
    expect(m1[0].pitches[0].step).toBe('C')
    expect(m1[0].duration).toBe('half')
    expect(m1[1].pitches[0].step).toBe('rest')
    expect(m1[1].duration).toBe('half')
    expect(() => validateScore(out)).not.toThrow()
  })
})

describe('reorderBalanced — cross-barline with cascade', () => {
  it('cascades a whole into a 3/4 (capacity 24) score across two measures', () => {
    // 3/4 with three measures, each [dotted-half]. Drag whole from where? Need a whole in source first.
    // 3/4 capacity is 24; whole=32. A whole can't fit in 3/4 as a single event — validateScore would reject.
    // Use 4/4 score, drop a whole into a 3/4-meter score? No — single meter per score.
    // OK use 4/4 with whole notes. Drop the first whole at front of m1; m1's whole gets displaced;
    // since whole exactly fills 4/4, no cascade. Not a cascade example.
    // For cascade we need event_units > capacity_units. In any single-meter context, event ≤ whole=32,
    // capacity is e.g. 32 (4/4), 24 (3/4), 16 (2/4 or C|), 8 (1/4 or 2/8), etc.
    // To force cascade: meter where capacity < 32, source event = whole (32).
    // But a whole-note in a 3/4 score would already violate validateScore on the source side.
    // So we need a source score where the dragged event has its own room.
    // Construction: 4/4 with whole notes, but the destination is a 3/4 score... not possible in one score.
    // OK use a meter like 7/8 (capacity 28) with dotted-half (24u) events. Drag a dotted-half to front
    // of next measure. Front consume: dotted-half overshoots remaining... no wait.
    // Trying again: 5/4 (capacity 40) — even a whole fits. Use 3/8 (capacity 12). Dotted-quarter (12u)
    // events fit. Half-note (16u) wouldn't fit even initially.
    // For genuine cascade in a single-meter context: the dragged event's duration must exceed the
    // available room at the drop point. Example: 4/4 with [Q, Q, half] in m0 and a long event in m1.
    // Drag a half from m0 (eventIdx=2, 16u) to position 24 in m1 (4/4, capacity 32). Available = 32-24=8.
    // 8 < 16, so half cascades: 8 in m1 + 8 in m2.
    const score: Score = buildScore({
      meter: '4/4',
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'half')] }, // 8+8+16=32
        { events: [note('F', 'quarter'), note('G', 'quarter'), note('A', 'quarter'), note('B', 'quarter')] }, // 8+8+8+8=32
        { events: [note('C', 'whole')] }, // 32
      ],
    })
    const out = transformScoreBalanced(score, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 2 }, // E half
      target: { measureIdx: 1, position32nds: 24 }, // after 3 quarters in m1
    })
    expect(() => validateScore(out)).not.toThrow()
    // m1 should have F, G, A then tied quarter (from cascade), totalling 32u
    // Source m0 should rest-fill the half slot → C, D, half-rest
    expect(out.measures[0].events.map((e) => `${e.pitches[0].step}:${e.duration}`)).toEqual([
      'C:quarter', 'D:quarter', 'rest:half',
    ])
    // m1: F, G, A, then quarter (tied) at the cascade tail
    const m1 = out.measures[1].events
    expect(m1[m1.length - 1].tied_to_next).toBe(true)
    // m2: cascaded quarter at front (tied from m1), then the whole was displaced
    // by the consume — wait, m2 had [whole=32], cascade adds quarter (8u) at front,
    // consumeForRoom(m2, 'front', 8) takes the whole (32) and leftover=24 → rest:dotted-half.
    const m2 = out.measures[2].events
    expect(m2[0].duration).toBe('quarter')
    expect(m2[0].pitches[0].step).toBe('E') // same pitch as moved event
  })

  it('throws cascade_overflow when the cascade exceeds remaining measures', () => {
    // 5/4 (cap 40) so a whole can coexist with another event in its measure.
    // Drag whole from m2[0] into mid-m1; cascade needs m3 which doesn't exist.
    const score: Score = buildScore({
      meter: '5/4',
      measures: [
        { events: [note('A', 'quarter'), note('B', 'quarter'), note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter')] },
        { events: [note('F', 'half'), note('G', 'quarter'), note('A', 'quarter'), note('B', 'quarter')] },
        { events: [note('C', 'whole'), note('D', 'quarter')] },
      ],
    })
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 2, eventIdx: 0 }, // whole
        target: { measureIdx: 1, position32nds: 24 },
      }),
    ).toThrow(BalanceError)
  })

  it('throws cascade_overflow if the cascade would overlap the source measure', () => {
    // 5/4 (cap 40). Drag whole left from m1 to mid-m0; cascade target is m1 = src.
    const score: Score = buildScore({
      meter: '5/4',
      measures: [
        { events: [note('A', 'quarter'), note('B', 'quarter'), note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter')] },
        { events: [note('F', 'whole'), note('G', 'quarter')] },
      ],
    })
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 1, eventIdx: 0 }, // whole
        target: { measureIdx: 0, position32nds: 24 },
      }),
    ).toThrow(BalanceError)
  })
})

describe('reorderBalanced — protection', () => {
  it('throws would_empty_measure when source has only one event', () => {
    const score: Score = buildScore({
      meter: '4/4',
      measures: [
        { events: [note('C', 'whole')] },
        { events: [note('D', 'whole')] },
      ],
    })
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 0 },
        target: { measureIdx: 1, position32nds: 0 },
      }),
    ).toThrow(BalanceError)
  })

  it('throws tuplet_blocked when moving a tuplet member', () => {
    const score: Score = buildScore({
      meter: '4/4',
      measures: [
        { events: [
          note('C', 'eighth', { tuplet: 3 }),
          note('D', 'eighth', { tuplet: 3 }),
          note('E', 'eighth', { tuplet: 3 }),
          note('F', 'half'),
          note('G', 'quarter'),
        ] },
        { events: [note('A', 'whole')] },
      ],
    })
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 0 },
        target: { measureIdx: 1, position32nds: 0 },
      }),
    ).toThrow(BalanceError)
  })

  it('throws tuplet_blocked when consuming would partially eat a tuplet at destination front', () => {
    const score: Score = buildScore({
      meter: '4/4',
      measures: [
        { events: [note('A', 'quarter'), note('B', 'quarter'), note('C', 'quarter'), note('D', 'quarter')] },
        { events: [
          note('E', 'eighth', { tuplet: 3 }),
          note('F', 'eighth', { tuplet: 3 }),
          note('G', 'eighth', { tuplet: 3 }),
          note('H' as 'A', 'half'),
          note('I' as 'A', 'quarter'),
        ] },
      ],
    })
    // Drag B from m0 to front of m1 → would consume tuplet members → blocked.
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 1 },
        target: { measureIdx: 1, position32nds: 0 },
      }),
    ).toThrow(BalanceError)
  })

  it('throws unrepresentable when drop position is out of bounds', () => {
    expect(() =>
      transformScoreBalanced(TWO_BARS_FOUR_QUARTERS, {
        kind: 'reorderBalanced',
        selection: { measureIdx: 0, eventIdx: 0 },
        target: { measureIdx: 1, position32nds: 100 },
      }),
    ).toThrow(BalanceError)
  })
})

describe('reorderBalanced — meter variants', () => {
  it('handles cut-time C| (capacity 16 32nds)', () => {
    const score: Score = buildScore({
      meter: 'C|',
      measures: [
        { events: [note('C', 'half')] },                                  // 16
        { events: [note('D', 'quarter'), note('E', 'quarter')] },         // 8+8=16
      ],
    })
    // Drag D from m1 to position 0 of m0 (replacing half).
    const out = transformScoreBalanced(score, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 1, eventIdx: 0 },
      target: { measureIdx: 0, position32nds: 0 },
    })
    expect(() => validateScore(out)).not.toThrow()
  })

  it('handles 7/8 (capacity 28 32nds)', () => {
    const score: Score = buildScore({
      meter: '7/8',
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'eighth')] }, // 8+8+8+4=28
        { events: [note('G', 'half'), note('A', 'quarter'), note('B', 'eighth')] },                          // 16+8+4=28
      ],
    })
    const out = transformScoreBalanced(score, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    expect(() => validateScore(out)).not.toThrow()
  })
})

describe('changeDurationBalanced', () => {
  it('same duration is a no-op (same score reference)', () => {
    const out = transformScoreBalanced(FOUR_QUARTERS_4_4, {
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      duration: 'quarter',
    })
    expect(out).toBe(FOUR_QUARTERS_4_4)
  })

  it('shrink: rest fills the freed space immediately after', () => {
    const score: Score = buildScore({
      measures: [{ events: [note('C', 'half'), note('D', 'half')] }],
    })
    const out = transformScoreBalanced(score, {
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      duration: 'quarter',
    })
    const events = out.measures[0].events
    expect(events.map((e) => `${e.pitches[0].step}:${e.duration}`)).toEqual([
      'C:quarter', 'rest:quarter', 'D:half',
    ])
    expect(() => validateScore(out)).not.toThrow()
  })

  it('grow within-measure: displaces following event', () => {
    // m0 = [Q, Q, Q, Q]. Grow C from quarter to half. Need 8 more units → consume D.
    const out = transformScoreBalanced(FOUR_QUARTERS_4_4, {
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      duration: 'half',
    })
    const events = out.measures[0].events
    expect(events.map((e) => `${e.pitches[0].step}:${e.duration}`)).toEqual([
      'C:half', 'E:quarter', 'F:quarter',
    ])
    expect(() => validateScore(out)).not.toThrow()
  })

  it('grow within-measure with overshoot: leaves a rest after', () => {
    // m0 = [Q, eighth, eighth, half]. Grow C from Q to dotted-quarter (+4 units).
    // After C: eighth (4u). consume(after, 'front', 4) consumes eighth exactly → no rest.
    // Let's use a different setup with overshoot: m0 = [eighth (4), half (16), Q (8), Q (eighth=4)].
    // Grow eighth (C) to half (+12). Need 12 from after. half is 16 → consume, leftover=4 → rest eighth.
    // After: rest eighth, Q, eighth — that's 4+8+4 = 16. C grew by 12 (from 4 to 16). Original total = 4+16+8+4=32. New total = 16+4+8+4=32. ✓
    const score: Score = buildScore({
      measures: [{ events: [note('C', 'eighth'), note('D', 'half'), note('E', 'quarter'), note('F', 'eighth')] }],
    })
    const out = transformScoreBalanced(score, {
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      duration: 'half',
    })
    const events = out.measures[0].events
    expect(events.map((e) => `${e.pitches[0].step}:${e.duration}`)).toEqual([
      'C:half', 'rest:eighth', 'E:quarter', 'F:eighth',
    ])
    expect(() => validateScore(out)).not.toThrow()
  })

  it('grow that cascades into next measure', () => {
    // 4/4: m0 = [Q, Q, Q, Q], m1 = [Q, Q, Q, Q]. Grow F (eventIdx=3 in m0) from quarter to whole.
    // Event start in m0 = 8+8+8 = 24. New end = 24+32 = 56 > 32 → cascade. roomHere = 32-24 = 8.
    // tieSplitOver(whole, 8, 32) → parts [8, 24]. dst: half-of-event. m1: dotted-half tied.
    // m0 = C, D, E, then the dst portion (quarter tied to dotted-half in m1).
    // m1: cascadeGroup[1] (dotted-half) consumes 24 from front of m1.
    // m1 originally [Q, Q, Q, Q] = 32. consume('front', 24) takes 3 quarters, leftover 0, remaining [Q].
    // m1 new = [dotted-half tied (24u), Q (8u)] = 32. ✓
    const out = transformScoreBalanced(TWO_BARS_FOUR_QUARTERS, {
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 0, eventIdx: 3 },
      duration: 'whole',
    })
    expect(() => validateScore(out)).not.toThrow()
    const m0 = out.measures[0].events
    expect(m0[m0.length - 1].tied_to_next).toBe(true)
  })

  it('throws tuplet_blocked when growing a tuplet member', () => {
    const score: Score = buildScore({
      measures: [{ events: [
        note('C', 'eighth', { tuplet: 3 }),
        note('D', 'eighth', { tuplet: 3 }),
        note('E', 'eighth', { tuplet: 3 }),
        note('F', 'half'),
        note('G', 'quarter'),
      ] }],
    })
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'changeDurationBalanced',
        selection: { measureIdx: 0, eventIdx: 0 },
        duration: 'quarter',
      }),
    ).toThrow(BalanceError)
  })

  it('throws cascade_overflow when grown event has no room to cascade', () => {
    const score: Score = buildScore({
      meter: '4/4',
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] },
        // No m1.
      ],
    })
    // Grow F to whole would need cascade beyond end of score.
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'changeDurationBalanced',
        selection: { measureIdx: 0, eventIdx: 3 },
        duration: 'whole',
      }),
    ).toThrow(BalanceError)
  })
})

describe('removeBalanced', () => {
  it('replaces removed event with same-duration rest', () => {
    const out = transformScoreBalanced(FOUR_QUARTERS_4_4, {
      kind: 'removeBalanced',
      selection: { measureIdx: 0, eventIdx: 1 },
    })
    expect(out.measures[0].events.map((e) => `${e.pitches[0].step}:${e.duration}`)).toEqual([
      'C:quarter', 'rest:quarter', 'E:quarter', 'F:quarter',
    ])
    expect(() => validateScore(out)).not.toThrow()
  })

  it('throws tuplet_blocked when removing a tuplet member', () => {
    const score: Score = buildScore({
      measures: [{ events: [
        note('C', 'eighth', { tuplet: 3 }),
        note('D', 'eighth', { tuplet: 3 }),
        note('E', 'eighth', { tuplet: 3 }),
        note('F', 'half'),
        note('G', 'quarter'),
      ] }],
    })
    expect(() =>
      transformScoreBalanced(score, {
        kind: 'removeBalanced',
        selection: { measureIdx: 0, eventIdx: 0 },
      }),
    ).toThrow(BalanceError)
  })

  it('merges resulting adjacent rests', () => {
    const score: Score = buildScore({
      measures: [{ events: [
        rest('quarter'),
        note('C', 'quarter'),
        rest('quarter'),
        note('D', 'quarter'),
      ] }],
    })
    const out = transformScoreBalanced(score, {
      kind: 'removeBalanced',
      selection: { measureIdx: 0, eventIdx: 1 }, // remove C
    })
    // [restQ, restQ-from-C, restQ, D] → mergeAdjacentRests merges
    // incrementally: 3 quarter rests collapse to a single dotted-half.
    const events = out.measures[0].events
    expect(events).toHaveLength(2)
    expect(events[0].duration).toBe('dotted-half')
    expect(events[0].pitches[0].step).toBe('rest')
    expect(events[1].pitches[0].step).toBe('D')
    expect(() => validateScore(out)).not.toThrow()
  })
})

describe('multi-staff', () => {
  it('reorderBalanced on secondStaff works without disturbing the primary', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [note('C', 'whole')] },
        { events: [note('D', 'whole')] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [note('E', 'quarter'), note('F', 'quarter'), note('G', 'quarter'), note('A', 'quarter')] },
          { events: [note('B', 'quarter'), note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter')] },
        ],
      } as Staff,
    }
    const out = transformScoreBalanced(score, {
      kind: 'reorderBalanced',
      selection: { staffIdx: 1, measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    // Primary staff unchanged
    expect(out.measures[0].events[0].pitches[0].step).toBe('C')
    expect(out.measures[1].events[0].pitches[0].step).toBe('D')
    // SecondStaff m0 has a quarter rest at the dragged-from position
    expect(out.secondStaff!.measures[0].events[0].pitches[0].step).toBe('rest')
    expect(out.secondStaff!.measures[1].events[0].pitches[0].step).toBe('E') // dragged event
    expect(() => validateScore(out)).not.toThrow()
  })
})

describe('validateScore invariant', () => {
  it('every successful balanced op produces a measure-valid score', () => {
    const ops: BalancedOp[] = [
      { kind: 'reorderBalanced', selection: { measureIdx: 0, eventIdx: 0 }, target: { measureIdx: 1, position32nds: 0 } },
      { kind: 'reorderBalanced', selection: { measureIdx: 1, eventIdx: 3 }, target: { measureIdx: 0, position32nds: 32 } },
      { kind: 'changeDurationBalanced', selection: { measureIdx: 0, eventIdx: 1 }, duration: 'half' },
      { kind: 'changeDurationBalanced', selection: { measureIdx: 0, eventIdx: 0 }, duration: 'eighth' },
      { kind: 'removeBalanced', selection: { measureIdx: 0, eventIdx: 0 } },
    ]
    for (const op of ops) {
      const out = transformScoreBalanced(TWO_BARS_FOUR_QUARTERS, op)
      expect(() => validateScore(out), `op ${op.kind}`).not.toThrow()
    }
  })
})
