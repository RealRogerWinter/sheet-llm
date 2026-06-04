import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import { validateScore } from '@/lib/music/validateScore'
import type { Score } from '@/lib/music/types'

const stepArb = fc.constantFrom('C', 'D', 'E', 'F', 'G', 'A', 'B' as const)
const octaveArb = fc.integer({ min: 3, max: 5 })
const quarterEventArb = fc.record({
  pitches: fc.array(fc.record({ step: stepArb, octave: octaveArb }), { minLength: 1, maxLength: 1 }),
  duration: fc.constant('quarter' as const),
})

/** Build a deterministic 4/4 measure consisting of 4 quarter events. */
const measureArb = fc.array(quarterEventArb, { minLength: 4, maxLength: 4 }).map((events) => ({ events }))

const scoreArb: fc.Arbitrary<Score> = fc.record({
  key: fc.constantFrom('C', 'G', 'D', 'F', 'Bb', 'Am', 'Em' as const),
  meter: fc.constant('4/4' as const),
  measures: fc.array(measureArb, { minLength: 1, maxLength: 8 }),
})

describe('scoreToAbc — property tests', () => {
  it('any zod-valid score transpiles without throwing', () => {
    fc.assert(
      fc.property(scoreArb, (s) => {
        const validated = validateScore(s)
        const abc = scoreToAbc(validated)
        expect(typeof abc).toBe('string')
        expect(abc.length).toBeGreaterThan(0)
      }),
      { numRuns: 50 },
    )
  })

  it('emitted ABC always starts with X:1 and contains K:', () => {
    fc.assert(
      fc.property(scoreArb, (s) => {
        const abc = scoreToAbc(validateScore(s))
        expect(abc.startsWith('X:1')).toBe(true)
        expect(abc).toContain('K:')
      }),
      { numRuns: 50 },
    )
  })

  it('measure count equals barline count in the body', () => {
    fc.assert(
      fc.property(scoreArb, (s) => {
        const validated = validateScore(s)
        const abc = scoreToAbc(validated)
        const body = abc.split('\nK:')[1].split('\n').slice(1).join('')
        const barlines = (body.match(/\|/g) ?? []).length
        expect(barlines).toBe(validated.measures.length)
      }),
      { numRuns: 50 },
    )
  })
})
