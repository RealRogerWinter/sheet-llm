// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveModelClass, type ModelCallType } from '@/lib/providers/modelClass'

// PR-8 — the Advanced Composer (Opus) routing seam. `large` is returned ONLY
// for a heavy compositional call with the resolved Advanced toggle on; every
// other combination stays on `medium` (Sonnet). This is the single choke point
// the credit hold sizing (billing/valueTier.ts) is kept in sync with.

const HEAVY: ModelCallType[] = ['whole_score', 'extend']
const NON_HEAVY: ModelCallType[] = [
  'section',
  'edit',
  'plan',
  'dispatch',
  'classify',
  'converse',
  'bounded',
]

describe('resolveModelClass', () => {
  it('routes heavy compositional calls to Opus (large) when Advanced is on', () => {
    for (const callType of HEAVY) {
      expect(resolveModelClass({ advancedComposer: true, callType })).toBe('large')
    }
  })

  it('keeps heavy calls on Sonnet (medium) when Advanced is OFF / absent', () => {
    for (const callType of HEAVY) {
      expect(resolveModelClass({ advancedComposer: false, callType })).toBe('medium')
      expect(resolveModelClass({ callType })).toBe('medium')
    }
  })

  it('NEVER routes a non-heavy call to Opus, even with Advanced on', () => {
    // Selective routing: classify/plan/dispatch/converse/edit, the bounded free
    // handler, AND the sectional seed/extend loop stay on Sonnet regardless.
    for (const callType of NON_HEAVY) {
      expect(resolveModelClass({ advancedComposer: true, callType })).toBe('medium')
    }
  })

  it('only an explicit boolean true engages Opus (no truthy coercion surprises)', () => {
    // The route resolves advancedComposer to a real boolean; guard against a
    // future caller passing a truthy non-boolean and silently unlocking Opus.
    expect(
      resolveModelClass({
        advancedComposer: undefined,
        callType: 'whole_score',
      }),
    ).toBe('medium')
    // @ts-expect-error — a non-boolean must not be accepted as "on".
    expect(resolveModelClass({ advancedComposer: 1, callType: 'whole_score' })).toBe('medium')
  })

  it('never returns small (the classifier/planner pick that explicitly)', () => {
    const all: ModelCallType[] = [...HEAVY, ...NON_HEAVY]
    for (const callType of all) {
      expect(resolveModelClass({ advancedComposer: true, callType })).not.toBe('small')
      expect(resolveModelClass({ advancedComposer: false, callType })).not.toBe('small')
    }
  })
})
