// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveModelClass, type ModelCallType } from '@/lib/providers/modelClass'

// SHE-19 — the seam now DEFAULTS to the cheapest tier (Haiku/small) and escalates:
//   advanced + heavy compositional  -> large (Opus)
//   complexity === 'complex'        -> medium (Sonnet)
//   otherwise                       -> small (Haiku)  [the new default]
const HEAVY: ModelCallType[] = ['whole_score', 'extend']
const NON_HEAVY: ModelCallType[] = ['section', 'edit', 'plan', 'dispatch', 'classify', 'converse', 'bounded']
const ALL: ModelCallType[] = [...HEAVY, ...NON_HEAVY]

describe('resolveModelClass', () => {
  it('defaults every call type to small (Haiku) when complexity is absent / simple', () => {
    for (const callType of ALL) {
      expect(resolveModelClass({ callType })).toBe('small')
      expect(resolveModelClass({ callType, complexity: 'simple' })).toBe('small')
    }
  })

  it('escalates to medium (Sonnet) when complexity is complex (no advanced toggle)', () => {
    for (const callType of ALL) {
      expect(resolveModelClass({ callType, complexity: 'complex' })).toBe('medium')
    }
  })

  it('routes heavy compositional calls to Opus (large) only with Advanced on', () => {
    for (const callType of HEAVY) {
      expect(resolveModelClass({ advancedComposer: true, callType })).toBe('large')
      expect(resolveModelClass({ advancedComposer: true, callType, complexity: 'complex' })).toBe('large')
    }
  })

  it('never routes a NON-heavy call to Opus, even with Advanced on', () => {
    for (const callType of NON_HEAVY) {
      expect(resolveModelClass({ advancedComposer: true, callType })).toBe('small')
      expect(resolveModelClass({ advancedComposer: true, callType, complexity: 'complex' })).toBe('medium')
    }
  })

  it('only an explicit boolean true engages Opus (no truthy coercion)', () => {
    expect(resolveModelClass({ advancedComposer: undefined, callType: 'whole_score' })).toBe('small')
    // @ts-expect-error — a non-boolean must not be accepted as "on".
    expect(resolveModelClass({ advancedComposer: 1, callType: 'whole_score' })).toBe('small')
  })
})
