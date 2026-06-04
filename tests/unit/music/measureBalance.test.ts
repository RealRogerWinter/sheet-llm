import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  BalanceError,
  DURATION_32NDS,
  MAX_CASCADE_DEPTH,
  consumeForRoom,
  decompose32nds,
  durationTo32nds,
  fillWithRests,
  mergeAdjacentRests,
  tieSplitEvent,
  tieSplitOver,
} from '@/lib/music/measureBalance'
import type { Duration, Event } from '@/lib/music/types'

const ALL_DURATIONS: Duration[] = [
  'whole', 'dotted-half', 'half', 'dotted-quarter', 'quarter',
  'dotted-eighth', 'eighth', 'sixteenth', '32nd',
]

function note(step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', duration: Duration, extras: Partial<Event> = {}): Event {
  return { pitches: [{ step, octave: 4 }], duration, ...extras }
}

function rest(duration: Duration, extras: Partial<Event> = {}): Event {
  return { pitches: [{ step: 'rest', octave: 4 }], duration, ...extras }
}

function sumUnits(events: Event[]): number {
  return events.reduce((acc, e) => acc + DURATION_32NDS[e.duration], 0)
}

describe('DURATION_32NDS', () => {
  it('matches eighths × 4 for every duration', () => {
    expect(DURATION_32NDS.whole).toBe(32)
    expect(DURATION_32NDS['dotted-half']).toBe(24)
    expect(DURATION_32NDS.half).toBe(16)
    expect(DURATION_32NDS['dotted-quarter']).toBe(12)
    expect(DURATION_32NDS.quarter).toBe(8)
    expect(DURATION_32NDS['dotted-eighth']).toBe(6)
    expect(DURATION_32NDS.eighth).toBe(4)
    expect(DURATION_32NDS.sixteenth).toBe(2)
    expect(DURATION_32NDS['32nd']).toBe(1)
  })

  it('every value is a positive integer', () => {
    for (const d of ALL_DURATIONS) {
      const v = DURATION_32NDS[d]
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})

describe('durationTo32nds', () => {
  it('returns the 32nd-unit value', () => {
    expect(durationTo32nds('whole')).toBe(32)
    expect(durationTo32nds('quarter')).toBe(8)
    expect(durationTo32nds('32nd')).toBe(1)
  })
})

describe('decompose32nds', () => {
  it('produces a single-element list for exact-match durations', () => {
    for (const d of ALL_DURATIONS) {
      const units = DURATION_32NDS[d]
      expect(decompose32nds(units)).toEqual([d])
    }
  })

  it('decomposes 5 as eighth + 32nd (greedy)', () => {
    expect(decompose32nds(5)).toEqual(['eighth', '32nd'])
  })

  it('decomposes 7 as dotted-eighth + 32nd', () => {
    expect(decompose32nds(7)).toEqual(['dotted-eighth', '32nd'])
  })

  it('decomposes 9 as quarter + 32nd', () => {
    expect(decompose32nds(9)).toEqual(['quarter', '32nd'])
  })

  it('decomposes 31 (greedy, multi-event)', () => {
    const out = decompose32nds(31)
    expect(out.reduce((s, d) => s + DURATION_32NDS[d], 0)).toBe(31)
    expect(out[0]).toBe('dotted-half')
  })

  it('throws BalanceError for zero, negatives, non-integers', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => decompose32nds(bad)).toThrow(BalanceError)
    }
  })

  it('result is ordered largest-first', () => {
    const out = decompose32nds(23)
    for (let i = 1; i < out.length; i++) {
      expect(DURATION_32NDS[out[i - 1]]).toBeGreaterThanOrEqual(DURATION_32NDS[out[i]])
    }
  })

  it('every positive integer 1..256 decomposes and sums correctly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 256 }), (n) => {
        const out = decompose32nds(n)
        expect(out.reduce((s, d) => s + DURATION_32NDS[d], 0)).toBe(n)
      }),
      { numRuns: 300 },
    )
  })
})

describe('fillWithRests', () => {
  it('produces rests totalling `units` 32nds', () => {
    const r = fillWithRests(8)
    expect(r).toHaveLength(1)
    expect(r[0].duration).toBe('quarter')
    expect(r[0].pitches[0].step).toBe('rest')
    expect(r[0].pitches[0].octave).toBe(4)
  })

  it('default octave is 4', () => {
    expect(fillWithRests(4)[0].pitches[0].octave).toBe(4)
  })

  it('custom octave is respected', () => {
    expect(fillWithRests(4, 5)[0].pitches[0].octave).toBe(5)
  })

  it('multi-event sequences for non-clean values', () => {
    const r = fillWithRests(5)
    expect(r.map((e) => e.duration)).toEqual(['eighth', '32nd'])
  })

  it('no metadata leaks (tuplet, tied, articulation, ornament, dynamic)', () => {
    for (const e of fillWithRests(31)) {
      expect(e.tuplet).toBeUndefined()
      expect(e.tied_to_next).toBeUndefined()
      expect(e.articulation).toBeUndefined()
      expect(e.ornament).toBeUndefined()
      expect(e.dynamic).toBeUndefined()
    }
  })

  it('throws on invalid units', () => {
    expect(() => fillWithRests(0)).toThrow(BalanceError)
    expect(() => fillWithRests(-1)).toThrow(BalanceError)
  })
})

describe('tieSplitEvent', () => {
  it('single-part returns a clone (different reference, same data)', () => {
    const src = note('C', 'quarter')
    const out = tieSplitEvent(src, [8])
    expect(out).toHaveLength(1)
    expect(out[0]).not.toBe(src)
    expect(out[0].pitches).not.toBe(src.pitches)
    expect(out[0].pitches[0]).not.toBe(src.pitches[0])
    expect(out[0].duration).toBe('quarter')
  })

  it('two equal parts produce two events tied together', () => {
    const src = note('D', 'half') // 16 units
    const out = tieSplitEvent(src, [8, 8])
    expect(out).toHaveLength(2)
    expect(out[0].duration).toBe('quarter')
    expect(out[1].duration).toBe('quarter')
    expect(out[0].tied_to_next).toBe(true)
    expect(out[1].tied_to_next).toBeUndefined()
  })

  it('preserves original tied_to_next on the last emitted event', () => {
    const src = note('E', 'half', { tied_to_next: true })
    const out = tieSplitEvent(src, [8, 8])
    expect(out[0].tied_to_next).toBe(true)
    expect(out[1].tied_to_next).toBe(true)
  })

  it('articulation/ornament/dynamic carry only on the first event', () => {
    const src = note('F', 'half', {
      articulation: 'accent',
      ornament: 'trill',
      dynamic: 'mf',
    })
    const out = tieSplitEvent(src, [8, 8])
    expect(out[0].articulation).toBe('accent')
    expect(out[0].ornament).toBe('trill')
    expect(out[0].dynamic).toBe('mf')
    expect(out[1].articulation).toBeUndefined()
    expect(out[1].ornament).toBeUndefined()
    expect(out[1].dynamic).toBeUndefined()
  })

  it('parts may themselves decompose into multiple events (ties everywhere except the last)', () => {
    const src = note('G', 'whole') // 32 units
    const out = tieSplitEvent(src, [7, 25]) // 7 → dotted-eighth+32nd; 25 → dotted-half+32nd
    expect(out).toHaveLength(4)
    expect(out.slice(0, -1).every((e) => e.tied_to_next === true)).toBe(true)
    expect(out[out.length - 1].tied_to_next).toBeUndefined()
  })

  it('throws tuplet_unsplittable on tuplet events', () => {
    const src = note('C', 'eighth', { tuplet: 3 })
    expect(() => tieSplitEvent(src, [2, 2])).toThrow(BalanceError)
    try {
      tieSplitEvent(src, [2, 2])
    } catch (e) {
      expect((e as BalanceError).code).toBe('tuplet_unsplittable')
    }
  })

  it('throws unrepresentable when parts sum mismatches event duration', () => {
    const src = note('C', 'quarter') // 8
    expect(() => tieSplitEvent(src, [3, 3])).toThrow(BalanceError)
  })

  it('empty parts list returns empty array', () => {
    const src = note('C', 'quarter')
    expect(tieSplitEvent(src, [])).toEqual([])
  })

  it('does not mutate input pitches array', () => {
    const src = note('C', 'half', { tied_to_next: true })
    const before = JSON.stringify(src)
    tieSplitEvent(src, [8, 8])
    expect(JSON.stringify(src)).toBe(before)
  })

  it('chord pitches are all carried on every part', () => {
    const src: Event = {
      pitches: [{ step: 'C', octave: 4 }, { step: 'E', octave: 4 }, { step: 'G', octave: 4 }],
      duration: 'half',
    }
    const out = tieSplitEvent(src, [8, 8])
    expect(out[0].pitches.map((p) => p.step)).toEqual(['C', 'E', 'G'])
    expect(out[1].pitches.map((p) => p.step)).toEqual(['C', 'E', 'G'])
  })
})

describe('tieSplitOver', () => {
  it('returns [[clone]] when the event fits in the destination', () => {
    const src = note('C', 'quarter') // 8
    const out = tieSplitOver(src, 16, 32) // 16 room, 4/4 capacity
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveLength(1)
    expect(out[0][0].duration).toBe('quarter')
    expect(out[0][0]).not.toBe(src)
  })

  it('splits across two measures with a tie when overflow is 1 measure', () => {
    const src = note('D', 'whole') // 32 units
    const out = tieSplitOver(src, 8, 32) // 8 in dst, 24 cascades into m+1
    expect(out).toHaveLength(2)
    expect(sumUnits(out[0]) + sumUnits(out[1])).toBe(32)
    expect(out[0][out[0].length - 1].tied_to_next).toBe(true)
    expect(out[1][out[1].length - 1].tied_to_next).toBeUndefined()
  })

  it('cascades through 3 measures (depth 2) — the max allowed', () => {
    // 96 units total can't be one Duration; use a real edge: drop a
    // whole (32u) where only 8u fits in dst, capacity 8 per measure.
    // → 8 + 8 + 8 + 8 = 4 measures, depth=3 > MAX → overflow.
    // For depth-2 success: total 32, dst room 8, cap 12 → 8 + 12 + 12 = 32. ✓
    const src = note('E', 'whole') // 32
    const out = tieSplitOver(src, 8, 12)
    expect(out).toHaveLength(3)
    expect(sumUnits(out[0]) + sumUnits(out[1]) + sumUnits(out[2])).toBe(32)
  })

  it('throws cascade_overflow beyond MAX_CASCADE_DEPTH', () => {
    expect(MAX_CASCADE_DEPTH).toBe(2)
    const src = note('E', 'whole') // 32
    // 32 in pieces of 4 → 8 measures total. Way over depth 2.
    expect(() => tieSplitOver(src, 4, 4)).toThrow(BalanceError)
    try {
      tieSplitOver(src, 4, 4)
    } catch (e) {
      expect((e as BalanceError).code).toBe('cascade_overflow')
    }
  })

  it('throws tuplet_unsplittable for tuplet events', () => {
    const src = note('C', 'eighth', { tuplet: 3 })
    expect(() => tieSplitOver(src, 4, 8)).toThrow(BalanceError)
  })

  it('throws cascade_overflow if firstMeasureRoom <= 0', () => {
    const src = note('C', 'quarter')
    expect(() => tieSplitOver(src, 0, 32)).toThrow(BalanceError)
    expect(() => tieSplitOver(src, -1, 32)).toThrow(BalanceError)
  })

  it('all-but-last emitted event has tied_to_next true (within and across parts)', () => {
    const src = note('A', 'whole') // 32
    const out = tieSplitOver(src, 5, 32) // dst: 5 → eighth+32nd; rest: 27
    const flat = out.flat()
    for (let i = 0; i < flat.length - 1; i++) {
      expect(flat[i].tied_to_next, `flat[${i}] should be tied`).toBe(true)
    }
    expect(flat[flat.length - 1].tied_to_next).toBeUndefined()
  })

  it('preserves articulation only on the very first event', () => {
    const src = note('B', 'whole', { articulation: 'staccato' })
    const out = tieSplitOver(src, 8, 32)
    const flat = out.flat()
    expect(flat[0].articulation).toBe('staccato')
    flat.slice(1).forEach((e) => expect(e.articulation).toBeUndefined())
  })

  it('preserves source tied_to_next on the last emitted event', () => {
    const src = note('B', 'whole', { tied_to_next: true })
    const out = tieSplitOver(src, 8, 32)
    const flat = out.flat()
    expect(flat[flat.length - 1].tied_to_next).toBe(true)
  })

  it('handles cut-time C| capacity (16 32nds) correctly', () => {
    const src = note('C', 'whole') // 32
    const out = tieSplitOver(src, 8, 16) // 4/4 melody dragged into a C| context
    // 8 in dst + 16 cap + 8 cap = 32. Three measures, depth 2.
    expect(out).toHaveLength(3)
    expect(sumUnits(out[0]) + sumUnits(out[1]) + sumUnits(out[2])).toBe(32)
  })

  it('property: total units always matches event duration', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Duration>(...ALL_DURATIONS),
        fc.integer({ min: 1, max: 32 }),
        fc.integer({ min: 1, max: 32 }),
        (dur, firstRoom, cap) => {
          const src = note('C', dur)
          try {
            const out = tieSplitOver(src, firstRoom, cap)
            const flatSum = sumUnits(out.flat())
            expect(flatSum).toBe(DURATION_32NDS[dur])
          } catch (e) {
            // cascade_overflow is acceptable when MAX_CASCADE_DEPTH exceeded.
            expect(e).toBeInstanceOf(BalanceError)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('consumeForRoom', () => {
  const SRC = [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] // 8+8+8+8=32

  it('side=front exact match', () => {
    const r = consumeForRoom(SRC, 'front', 8)
    expect(r.remaining.map((e) => e.pitches[0].step)).toEqual(['D', 'E', 'F'])
    expect(r.consumed.map((e) => e.pitches[0].step)).toEqual(['C'])
    expect(r.consumedUnits).toBe(8)
    expect(r.leftoverUnits).toBe(0)
    expect(r.shortfallUnits).toBe(0)
    expect(r.blocked).toBeUndefined()
  })

  it('side=front overshoot', () => {
    const r = consumeForRoom(SRC, 'front', 5) // takes whole quarter (8), overshoots by 3
    expect(r.consumed).toHaveLength(1)
    expect(r.consumedUnits).toBe(8)
    expect(r.leftoverUnits).toBe(3)
    expect(r.shortfallUnits).toBe(0)
  })

  it('side=front shortfall when measure runs out', () => {
    const r = consumeForRoom(SRC, 'front', 40)
    expect(r.remaining).toEqual([])
    expect(r.consumed).toHaveLength(4)
    expect(r.consumedUnits).toBe(32)
    expect(r.leftoverUnits).toBe(0)
    expect(r.shortfallUnits).toBe(8)
  })

  it('side=back exact match', () => {
    const r = consumeForRoom(SRC, 'back', 8)
    expect(r.remaining.map((e) => e.pitches[0].step)).toEqual(['C', 'D', 'E'])
    expect(r.consumed.map((e) => e.pitches[0].step)).toEqual(['F'])
  })

  it('side=back consumes multiple from end', () => {
    const r = consumeForRoom(SRC, 'back', 16)
    expect(r.remaining.map((e) => e.pitches[0].step)).toEqual(['C', 'D'])
    expect(r.consumed.map((e) => e.pitches[0].step)).toEqual(['E', 'F'])
    expect(r.consumedUnits).toBe(16)
  })

  it('units=0 is a no-op', () => {
    const r = consumeForRoom(SRC, 'front', 0)
    expect(r.remaining).toBe(SRC)
    expect(r.consumed).toEqual([])
    expect(r.consumedUnits).toBe(0)
  })

  it('refuses to partially consume a tuplet (front)', () => {
    const triplet = [
      note('C', 'eighth', { tuplet: 3 }),
      note('D', 'eighth', { tuplet: 3 }),
      note('E', 'eighth', { tuplet: 3 }),
      note('F', 'quarter'),
    ]
    const r = consumeForRoom(triplet, 'front', 4)
    expect(r.blocked).toBe('tuplet')
    expect(r.remaining).toBe(triplet)
    expect(r.consumedUnits).toBe(0)
    expect(r.shortfallUnits).toBe(4)
  })

  it('refuses to partially consume a tuplet (back)', () => {
    const events = [
      note('F', 'quarter'),
      note('C', 'eighth', { tuplet: 3 }),
      note('D', 'eighth', { tuplet: 3 }),
      note('E', 'eighth', { tuplet: 3 }),
    ]
    const r = consumeForRoom(events, 'back', 4)
    expect(r.blocked).toBe('tuplet')
    expect(r.consumedUnits).toBe(0)
  })

  it('does not mutate the input array', () => {
    const before = JSON.stringify(SRC)
    consumeForRoom(SRC, 'front', 12)
    expect(JSON.stringify(SRC)).toBe(before)
  })

  it('property: consumedUnits + remaining units == input units (when not blocked or short)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            step: fc.constantFrom('C', 'D', 'E', 'F', 'G', 'A', 'B'),
            duration: fc.constantFrom<Duration>('quarter', 'eighth', 'half', 'sixteenth'),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 1, max: 64 }),
        fc.constantFrom<'front' | 'back'>('front', 'back'),
        (cfgs, units, side) => {
          const events: Event[] = cfgs.map((c) => note(c.step as 'C', c.duration))
          const total = sumUnits(events)
          const r = consumeForRoom(events, side, units)
          if (r.blocked) return
          expect(r.consumedUnits + sumUnits(r.remaining)).toBe(total)
          expect(r.consumed.length + r.remaining.length).toBe(events.length)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('mergeAdjacentRests', () => {
  it('merges two quarter rests into a half rest', () => {
    const out = mergeAdjacentRests([rest('quarter'), rest('quarter')])
    expect(out).toHaveLength(1)
    expect(out[0].duration).toBe('half')
    expect(out[0].pitches[0].step).toBe('rest')
  })

  it('incrementally collapses 4 quarter rests into a whole rest', () => {
    const out = mergeAdjacentRests([rest('quarter'), rest('quarter'), rest('quarter'), rest('quarter')])
    expect(out).toHaveLength(1)
    expect(out[0].duration).toBe('whole')
  })

  it('does not merge if the sum is not a single representable duration', () => {
    // dotted-eighth (6) + eighth (4) = 10 — not a single duration
    const out = mergeAdjacentRests([rest('dotted-eighth'), rest('eighth')])
    expect(out).toHaveLength(2)
  })

  it('does not merge across tuplet boundaries', () => {
    const out = mergeAdjacentRests([
      rest('eighth', { tuplet: 3 }),
      rest('eighth', { tuplet: 3 }),
    ])
    expect(out).toHaveLength(2)
  })

  it('does not merge if either rest has tied_to_next set', () => {
    const out = mergeAdjacentRests([rest('quarter', { tied_to_next: true }), rest('quarter')])
    expect(out).toHaveLength(2)
  })

  it('leaves rest + note alone', () => {
    const out = mergeAdjacentRests([rest('quarter'), note('C', 'quarter')])
    expect(out).toHaveLength(2)
  })

  it('leaves note + rest alone', () => {
    const out = mergeAdjacentRests([note('C', 'quarter'), rest('quarter')])
    expect(out).toHaveLength(2)
  })

  it('preserves octave of the first rest when merging', () => {
    const a: Event = { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' }
    const b: Event = { pitches: [{ step: 'rest', octave: 5 }], duration: 'quarter' }
    const out = mergeAdjacentRests([a, b])
    expect(out[0].pitches[0].octave).toBe(4)
  })

  it('does not mutate the input array', () => {
    const events = [rest('quarter'), rest('quarter')]
    const before = JSON.stringify(events)
    mergeAdjacentRests(events)
    expect(JSON.stringify(events)).toBe(before)
  })

  it('handles a sequence interleaved with notes', () => {
    const out = mergeAdjacentRests([
      rest('eighth'),
      rest('eighth'),
      note('C', 'quarter'),
      rest('sixteenth'),
      rest('sixteenth'),
    ])
    expect(out).toHaveLength(3)
    expect(out[0].duration).toBe('quarter') // 4+4=8
    expect(out[1].pitches[0].step).toBe('C')
    expect(out[2].duration).toBe('eighth') // 2+2=4
  })
})

describe('BalanceError', () => {
  it('carries code and details', () => {
    const e = new BalanceError('boom', 'cascade_overflow', { units: 12 })
    expect(e.code).toBe('cascade_overflow')
    expect(e.details?.units).toBe(12)
    expect(e.name).toBe('BalanceError')
    expect(e).toBeInstanceOf(Error)
  })
})

// Tests added in response to code-review findings on PR #38.
describe('tieSplitEvent — metadata preservation (review fixes)', () => {
  it('single-part split preserves articulation/ornament/dynamic on the (only) event', () => {
    const src = note('C', 'quarter', {
      articulation: 'accent',
      ornament: 'trill',
      dynamic: 'mf',
    })
    const out = tieSplitEvent(src, [8])
    expect(out).toHaveLength(1)
    expect(out[0].articulation).toBe('accent')
    expect(out[0].ornament).toBe('trill')
    expect(out[0].dynamic).toBe('mf')
  })

  it('single-part split preserves source tied_to_next', () => {
    const src = note('C', 'quarter', { tied_to_next: true })
    const out = tieSplitEvent(src, [8])
    expect(out[0].tied_to_next).toBe(true)
  })

  it('rejects non-positive-integer parts (zero)', () => {
    const src = note('C', 'quarter')
    expect(() => tieSplitEvent(src, [0, 8])).toThrow(BalanceError)
  })

  it('rejects non-positive-integer parts (negative)', () => {
    const src = note('C', 'quarter')
    expect(() => tieSplitEvent(src, [-1, 9])).toThrow(BalanceError)
  })

  it('rejects non-positive-integer parts (fractional)', () => {
    const src = note('C', 'quarter')
    expect(() => tieSplitEvent(src, [3.5, 4.5])).toThrow(BalanceError)
  })

  it('pitches arrays are NOT aliased across parts (independent references)', () => {
    const src = note('C', 'half') // 16 units
    const out = tieSplitEvent(src, [8, 8])
    expect(out).toHaveLength(2)
    expect(out[0].pitches).not.toBe(out[1].pitches)
    expect(out[0].pitches[0]).not.toBe(out[1].pitches[0])
    // Sanity: mutating one does not affect the other.
    out[0].pitches[0].octave = 6
    expect(out[1].pitches[0].octave).toBe(4)
  })

  it('tied chain shares identical pitches across all parts (musically required)', () => {
    const src: Event = {
      pitches: [{ step: 'C', octave: 4 }, { step: 'E', octave: 4 }, { step: 'G', octave: 4 }],
      duration: 'whole',
    }
    const out = tieSplitEvent(src, [16, 16])
    for (const e of out) {
      expect(e.pitches.map((p) => `${p.step}${p.octave}`)).toEqual(['C4', 'E4', 'G4'])
    }
  })
})

describe('tieSplitOver — metadata preservation (review fixes)', () => {
  it('fits-in-destination preserves articulation/ornament/dynamic', () => {
    const src = note('A', 'quarter', {
      articulation: 'accent',
      ornament: 'trill',
      dynamic: 'ff',
    })
    const out = tieSplitOver(src, 16, 32) // fits in 16 32nds; 4/4 capacity
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveLength(1)
    expect(out[0][0].articulation).toBe('accent')
    expect(out[0][0].ornament).toBe('trill')
    expect(out[0][0].dynamic).toBe('ff')
  })

  it('fits-in-destination preserves source tied_to_next', () => {
    const src = note('B', 'quarter', { tied_to_next: true })
    const out = tieSplitOver(src, 16, 32)
    expect(out[0][0].tied_to_next).toBe(true)
  })

  it('pitches arrays are NOT aliased across cascaded measures', () => {
    const src = note('C', 'whole') // 32 units
    const out = tieSplitOver(src, 8, 32) // 8 in dst, 24 in next
    const flat = out.flat()
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i].pitches).not.toBe(flat[0].pitches)
      expect(flat[i].pitches[0]).not.toBe(flat[0].pitches[0])
    }
    flat[0].pitches[0].octave = 6
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i].pitches[0].octave).toBe(4)
    }
  })

  it('chord events: every cascaded measure carries the full pitch set', () => {
    const src: Event = {
      pitches: [{ step: 'C', octave: 4 }, { step: 'E', octave: 4 }, { step: 'G', octave: 4 }],
      duration: 'whole',
    }
    const out = tieSplitOver(src, 8, 16)
    for (const part of out) {
      for (const e of part) {
        expect(e.pitches.map((p) => p.step)).toEqual(['C', 'E', 'G'])
      }
    }
  })
})

describe('consumeForRoom — mid-stream tuplet block (review gap)', () => {
  it('side=front: consumes plain events then blocks on tuplet, reverting partial consumption', () => {
    const events = [
      note('A', 'quarter'),                       // 8 units
      note('B', 'quarter'),                       // 8 units (plain)
      note('C', 'eighth', { tuplet: 3 }),         // tuplet member
      note('D', 'eighth', { tuplet: 3 }),
      note('E', 'eighth', { tuplet: 3 }),
    ]
    // We need 12 units from front. Consume A (8), need 4 more, next is plain quarter B (8) → consume,
    // now consumedUnits=16 >= 12 → break. Successful, no block.
    const r1 = consumeForRoom(events, 'front', 12)
    expect(r1.blocked).toBeUndefined()
    expect(r1.consumedUnits).toBe(16)

    // Now need 20 units. Consume A (8), B (8), need 4 more → next is tuplet → block.
    const r2 = consumeForRoom(events, 'front', 20)
    expect(r2.blocked).toBe('tuplet')
    expect(r2.consumedUnits).toBe(0) // partial revert
    expect(r2.consumed).toEqual([])
    expect(r2.remaining).toBe(events) // same reference
    expect(r2.shortfallUnits).toBe(20)
  })

  it('side=back: same mid-stream block behavior', () => {
    const events = [
      note('A', 'eighth', { tuplet: 3 }),
      note('B', 'eighth', { tuplet: 3 }),
      note('C', 'eighth', { tuplet: 3 }),
      note('D', 'quarter'),
      note('E', 'quarter'),
    ]
    // From back: consume E (8), D (8), need more (units=20) → next is tuplet → block, revert.
    const r = consumeForRoom(events, 'back', 20)
    expect(r.blocked).toBe('tuplet')
    expect(r.consumedUnits).toBe(0)
    expect(r.remaining).toBe(events)
  })
})

describe('mergeAdjacentRests — metadata drop policy (review L5)', () => {
  it('when merging, first rest wins for articulation / dynamic / ornament', () => {
    const a: Event = {
      pitches: [{ step: 'rest', octave: 4 }],
      duration: 'quarter',
      articulation: 'staccato',
      dynamic: 'mf',
    }
    const b: Event = {
      pitches: [{ step: 'rest', octave: 4 }],
      duration: 'quarter',
      articulation: 'accent',
      dynamic: 'p',
    }
    const out = mergeAdjacentRests([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].duration).toBe('half')
    expect(out[0].articulation).toBe('staccato') // first wins
    expect(out[0].dynamic).toBe('mf')            // first wins
  })
})
