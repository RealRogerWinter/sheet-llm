import { describe, it, expect } from 'vitest'
import { classify } from '@/lib/orchestrator/classifier'
import type { Score } from '@/lib/music/types'

/**
 * Smoke B — classifier recognizes a converse query against a present score.
 *
 * Loose contract: `converse` is the expected label for "what notes
 * are in measure N?" when a score is in session. We only assert
 * `kind === 'converse'` AND `confidence > 0.6` so prompt-tuning
 * churn doesn't flake CI.
 */

const RUN =
  process.env.RUN_SMOKE_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

const TWO_BAR_SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

describe.skipIf(!RUN)('smoke B: classifier on "what notes are in measure 2?"', () => {
  it('returns converse with confidence > 0.6', async () => {
    const result = await classify({
      userText: 'what notes are in measure 2?',
      editedScore: TWO_BAR_SCORE,
      history: [],
    })
    expect(result.kind).toBe('converse')
    expect(result.confidence).toBeGreaterThan(0.6)
  }, 30_000)
})

describe.skipIf(RUN)('smoke B: skipped (set RUN_SMOKE_EVALS=1 + ANTHROPIC_API_KEY)', () => {
  it('skip placeholder', () => {
    expect(true).toBe(true)
  })
})
