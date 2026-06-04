import { describe, it, expect } from 'vitest'
import { classify } from '@/lib/orchestrator/classifier'

/**
 * Classifier eval against a live Haiku endpoint. SKIPPED unless
 * RUN_EVALS=1 to avoid surprise API spend on every developer's
 * `pnpm test:eval` run.
 *
 * To run:
 *   RUN_EVALS=1 ANTHROPIC_API_KEY=sk-... pnpm test:eval
 *
 * Asserts a label-prediction floor (>= 80% match on the golden set)
 * — relaxed enough to survive prompt-tuning churn, strict enough to
 * catch tier-drift on common categories.
 */

const RUN = process.env.RUN_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

interface Case {
  text: string
  expectedKind:
    | 'edit_score_level'
    | 'edit_intra_measure'
    | 'generate_simple'
    | 'generate_complex'
    | 'compose'
    | 'converse'
    | 'refuse'
  /** When converse expects SCORE PRESENT, set this so the classifier
   *  call passes a non-undefined editedScore. */
  scorePresent?: boolean
}

const CASES: Case[] = [
  { text: 'a c major scale', expectedKind: 'generate_simple' },
  { text: 'a simple arpeggio in G', expectedKind: 'generate_simple' },
  { text: 'change the key to D major', expectedKind: 'edit_score_level' },
  { text: 'change the meter to 3/4', expectedKind: 'edit_score_level' },
  { text: 'set the tempo to 120', expectedKind: 'edit_score_level' },
  { text: 'raise the third note an octave', expectedKind: 'edit_intra_measure' },
  { text: 'add a fermata to the last note', expectedKind: 'edit_intra_measure' },
  { text: 'write a counterpoint to this line', expectedKind: 'compose' },
  { text: 'harmonize this melody with thirds', expectedKind: 'compose' },
  { text: 'compose a full sonata-form first movement', expectedKind: 'generate_complex' },
  // Multi-staff cue words (positive).
  { text: 'write a simple piano piece in C major', expectedKind: 'generate_complex' },
  { text: 'write an SATB hymn-style cadence in C', expectedKind: 'generate_complex' },
  { text: 'walking bass line in E minor for bass guitar', expectedKind: 'generate_simple' },
  { text: 'switch to bass clef', expectedKind: 'edit_score_level' },
  // Negative cases — these mention multi-staff keywords but are NOT
  // generation requests. The classifier must not over-trigger.
  { text: 'what is the history of SATB writing?', expectedKind: 'converse', scorePresent: true },
  { text: 'what is the alto doing in measure 3?', expectedKind: 'converse', scorePresent: true },
]

const STUB_SCORE_FOR_CONVERSE = {
  key: 'C' as const,
  meter: '4/4' as const,
  measures: [
    {
      events: [
        { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const },
      ],
    },
  ],
}

describe.skipIf(!RUN)('classifier eval — golden set (RUN_EVALS=1)', () => {
  it(`matches expected kind on >= 80% of ${CASES.length} cases`, async () => {
    const results = await Promise.all(
      CASES.map(async (c) => ({
        ...c,
        actual: (
          await classify({
            userText: c.text,
            editedScore: c.scorePresent ? STUB_SCORE_FOR_CONVERSE : undefined,
            history: [],
          })
        ).kind,
      })),
    )
    const correct = results.filter((r) => r.actual === r.expectedKind).length
    const accuracy = correct / results.length
    const misses = results.filter((r) => r.actual !== r.expectedKind)
    if (misses.length > 0) {
      console.log('Classifier misses:', misses)
    }
    expect(accuracy).toBeGreaterThanOrEqual(0.8)
  }, 60_000)
})

describe.skipIf(RUN)('classifier eval — skipped (set RUN_EVALS=1 and ANTHROPIC_API_KEY to run)', () => {
  it('is intentionally skipped to avoid API spend on default runs', () => {
    expect(true).toBe(true)
  })
})
