import { describe, it, expect } from 'vitest'
import { classify } from '@/lib/orchestrator/classifier'
import type { Score } from '@/lib/music/types'

/**
 * Smoke C — classifier recognizes a score-level edit ("change the
 * key to D") against a present score.
 *
 * Loose contract: `edit_score_level` is the expected label;
 * confidence > 0.6. We don't assert the score_level_ops payload
 * shape here — that's the job of a richer live-eval case in PR-5.
 */

const RUN =
  process.env.RUN_SMOKE_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

const SINGLE_BAR_SCORE: Score = {
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
  ],
}

describe.skipIf(!RUN)('smoke C: classifier on "change the key to D"', () => {
  it('returns edit_score_level with confidence > 0.6', async () => {
    const result = await classify({
      userText: 'change the key to D',
      editedScore: SINGLE_BAR_SCORE,
      history: [],
    })
    expect(result.kind).toBe('edit_score_level')
    expect(result.confidence).toBeGreaterThan(0.6)
  }, 30_000)
})

describe.skipIf(RUN)('smoke C: skipped (set RUN_SMOKE_EVALS=1 + ANTHROPIC_API_KEY)', () => {
  it('skip placeholder', () => {
    expect(true).toBe(true)
  })
})
