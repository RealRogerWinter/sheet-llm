import { describe, it, expect } from 'vitest'
import type { Score } from '@/lib/music/types'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'

const SCORE_A: Score = {
  title: 'A',
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
}

const SCORE_B: Score = {
  ...SCORE_A,
  key: 'G',
}

describe('orchestrator/scoreVersion.scoreHash', () => {
  it('returns a non-empty string', () => {
    const h = scoreHash(SCORE_A)
    expect(typeof h).toBe('string')
    expect(h.length).toBeGreaterThan(0)
  })

  it('is deterministic: same input → same hash', () => {
    const h1 = scoreHash(SCORE_A)
    const h2 = scoreHash(SCORE_A)
    expect(h1).toBe(h2)
  })

  it('differs for semantically different scores', () => {
    expect(scoreHash(SCORE_A)).not.toBe(scoreHash(SCORE_B))
  })

  it('is stable across cosmetic object-key reordering (canonical form)', () => {
    const reordered: Score = {
      measures: SCORE_A.measures,
      meter: SCORE_A.meter,
      key: SCORE_A.key,
      title: SCORE_A.title,
    }
    expect(scoreHash(SCORE_A)).toBe(scoreHash(reordered))
  })
})
