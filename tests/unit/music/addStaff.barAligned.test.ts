import { describe, it, expect } from 'vitest'
import { transformScore } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { secondStaffHasContent } from '@/lib/music/scoreAccessors'
import type { Meter, Score } from '@/lib/music/types'

function makeScore(meter: Meter, events: Score['measures'][0]['events']): Score {
  return { key: 'C', meter, measures: [{ events }] }
}

describe('addStaff — bar-aligned rest fill', () => {
  it('produces a valid score in 3/4', () => {
    const before = makeScore('3/4', [{ pitches: [{ step: 'C', octave: 4 }], duration: 'dotted-half' }])
    const after = transformScore(before, { kind: 'addStaff', clef: 'bass' })
    expect(after.secondStaff).toBeDefined()
    expect(after.secondStaff!.measures).toHaveLength(1)
    expect(() => validateScore(after)).not.toThrow()
  })

  it('produces a valid score in 6/8', () => {
    const before = makeScore('6/8', [{ pitches: [{ step: 'C', octave: 4 }], duration: 'dotted-half' }])
    const after = transformScore(before, { kind: 'addStaff', clef: 'bass' })
    expect(() => validateScore(after)).not.toThrow()
  })

  it('produces a valid score in 5/4 (multi-event decomposition)', () => {
    const before = makeScore('5/4', [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    ])
    const after = transformScore(before, { kind: 'addStaff', clef: 'bass' })
    expect(after.secondStaff!.measures[0].events.length).toBeGreaterThan(1)
    expect(() => validateScore(after)).not.toThrow()
  })

  it('produces a valid score in 7/8, 9/8, 11/8, 12/8', () => {
    for (const meter of ['7/8', '9/8', '11/8', '12/8'] as Meter[]) {
      const cap32 = { '7/8': 28, '9/8': 36, '11/8': 44, '12/8': 48 }[meter as '7/8' | '9/8' | '11/8' | '12/8']
      // Build a single rest of full capacity by running fill-with-rests
      // implicitly via insertMeasureAfter on a seed measure.
      const seed = makeScore('4/4', [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }])
      // Switch meter, then add staff — exercises addStaff under the
      // target meter. (changeMeter is allowed here because the seed
      // happens to be valid in 4/4; the test re-validates after.)
      const switched: Score = { ...seed, meter: meter }
      // Replace the now-misfit primary measure with a meter-correct one
      // so we're testing addStaff in isolation, not changeMeter.
      const fix = transformScore(switched, { kind: 'changeMeter', meter })
      void cap32
      void fix
      // Use the original (still 4/4) seed and switch via direct addStaff
      // — but we want addStaff under target meter, so build a fresh
      // valid score in `meter` instead.
      const fresh: Score = {
        key: 'C',
        meter,
        measures: [
          // Single measure of meter-sized rests, derived from
          // fillMeasureWithRests via insertMeasureAfter on a temp 1/4
          // anchor … but the cleanest is to call transformScore here:
          { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
        ],
      }
      // Manually fill primary correctly via insertMeasureAfter so the
      // pre-condition validates.
      const filled = transformScore(fresh, { kind: 'insertMeasureAfter', measureIdx: 0 })
      // Drop the original under-full measure to leave only the filled one.
      const trimmed: Score = { ...filled, measures: [filled.measures[1]] }
      expect(() => validateScore(trimmed), `pre-addStaff in ${meter}`).not.toThrow()
      const after = transformScore(trimmed, { kind: 'addStaff', clef: 'bass' })
      expect(() => validateScore(after), `post-addStaff in ${meter}`).not.toThrow()
    }
  })

  it('mirrors primary staff measure count', () => {
    const before: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const after = transformScore(before, { kind: 'addStaff', clef: 'bass' })
    expect(after.secondStaff!.measures).toHaveLength(3)
  })
})

describe('insertMeasureAfter — bar-aligned rest fill', () => {
  it('produces a valid score in non-4/4 meters', () => {
    const meters: Meter[] = ['3/4', '6/8', '5/4', '7/8', '9/8', '11/8', '12/8']
    for (const meter of meters) {
      // Seed a one-measure score with a meter-sized rest via the
      // helper-equivalent shape.
      const before: Score = {
        key: 'C',
        meter,
        measures: [
          { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
        ],
      }
      // The seed is intentionally invalid in non-4/4 (whole rest doesn't sum);
      // call insertMeasureAfter and validate only the *appended* measure
      // by replacing the primary with what was appended.
      const after = transformScore(before, { kind: 'insertMeasureAfter', measureIdx: 0 })
      expect(after.measures).toHaveLength(2)
      const appendedOnly: Score = { ...after, measures: [after.measures[1]] }
      expect(() => validateScore(appendedOnly), `meter ${meter}`).not.toThrow()
    }
  })
})

describe('secondStaffHasContent', () => {
  it('returns false when secondStaff is absent', () => {
    const score: Score = { key: 'C', meter: '4/4', measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }] }
    expect(secondStaffHasContent(score)).toBe(false)
  })

  it('returns false when secondStaff has only rest events', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] }],
      },
    }
    expect(secondStaffHasContent(score)).toBe(false)
  })

  it('returns true when secondStaff has any non-rest pitch', () => {
    const score: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
      },
    }
    expect(secondStaffHasContent(score)).toBe(true)
  })
})
