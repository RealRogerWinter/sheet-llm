import { describe, expect, it } from 'vitest'
import {
  verifyAllOriginalsPreserved,
  verifyPreservation,
} from '@/lib/orchestrator/preservationVerifier'
import type { Score } from '@/lib/music/types'

function fourBars(): Score {
  return {
    title: 'T',
    key: 'C',
    meter: '4/4',
    measures: Array.from({ length: 4 }, (_, i) => ({
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
        { pitches: [{ step: ['D', 'E', 'F', 'G'][i] as 'D' | 'E' | 'F' | 'G', octave: 4 }], duration: 'half' },
      ],
    })),
  }
}

describe('preservationVerifier: verifyPreservation', () => {
  it('ok=true when claimed measures are identical', () => {
    const before = fourBars()
    const after: Score = { ...before, measures: [...before.measures] }
    const result = verifyPreservation(before, after, [0, 1, 2, 3])
    expect(result.ok).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('ok=true when only NON-claimed measures changed', () => {
    const before = fourBars()
    const after: Score = {
      ...before,
      measures: [
        before.measures[0],
        before.measures[1],
        // bar 2 mutated:
        {
          events: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'half' },
          ],
        },
        before.measures[3],
      ],
    }
    // We only claim 0, 1, 3 retained → ok.
    const result = verifyPreservation(before, after, [0, 1, 3])
    expect(result.ok).toBe(true)
  })

  it('flags mismatches when claimed measures DO change', () => {
    const before = fourBars()
    const after: Score = {
      ...before,
      measures: [
        before.measures[0],
        // bar 1 mutated but we claim it retained:
        {
          events: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'half' },
          ],
        },
        before.measures[2],
        before.measures[3],
      ],
    }
    const result = verifyPreservation(before, after, [0, 1, 2])
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([1])
  })

  it('flags out-of-range indices as mismatches', () => {
    const before = fourBars()
    const after = fourBars()
    const result = verifyPreservation(before, after, [0, 99, -1])
    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual([99, -1])
  })
})

describe('preservationVerifier: verifyAllOriginalsPreserved', () => {
  it('verifies every original measure when appending (after = before+tail)', () => {
    const before = fourBars()
    const after: Score = {
      ...before,
      measures: [
        ...before.measures,
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
    }
    const result = verifyAllOriginalsPreserved(before, after)
    expect(result.ok).toBe(true)
  })

  it('flags every changed measure when after is wholesale replacement', () => {
    const before = fourBars()
    const after: Score = {
      ...before,
      title: '5/4 ostinato',
      key: 'Am',
      meter: '5/4',
      measures: Array.from({ length: 8 }, () => ({
        events: [
          { pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        ],
      })),
    }
    const result = verifyAllOriginalsPreserved(before, after)
    expect(result.ok).toBe(false)
    expect(result.mismatches.length).toBe(4)
  })
})
