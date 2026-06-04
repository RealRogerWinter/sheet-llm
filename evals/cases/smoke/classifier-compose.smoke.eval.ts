import { describe, it, expect } from 'vitest'
import { classify } from '@/lib/orchestrator/classifier'

/**
 * Smoke A — classifier doesn't crash on a routine extension prompt.
 *
 * Goal: assert the classifier returns *some* sane TaskKind with
 * confidence > 0.6. We deliberately don't pin which kind: the point
 * of a smoke is "tier-1 plumbing is alive", not "Haiku labels this
 * prompt the way I'd label it". A label-accuracy gate is a job for
 * the live-eval golden set (PR-5).
 *
 * Gated by `RUN_SMOKE_EVALS=1 ANTHROPIC_API_KEY=sk-...` so a stray
 * `pnpm test` never triggers an API call. Wired into a future CI
 * step via `npm run eval:smoke`.
 */

const RUN =
  process.env.RUN_SMOKE_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

describe.skipIf(!RUN)('smoke A: classifier on "add 4 more bars in C major"', () => {
  it('returns a sane TaskKind with confidence > 0.6', async () => {
    const result = await classify({
      userText: 'add 4 more bars in C major',
      editedScore: undefined,
      history: [],
    })
    expect([
      'compose',
      'edit_intra_measure',
      'generate_simple',
      'generate_complex',
    ]).toContain(result.kind)
    expect(result.confidence).toBeGreaterThan(0.6)
  }, 30_000)
})

describe.skipIf(RUN)('smoke A: skipped (set RUN_SMOKE_EVALS=1 + ANTHROPIC_API_KEY)', () => {
  it('skip placeholder', () => {
    expect(true).toBe(true)
  })
})
