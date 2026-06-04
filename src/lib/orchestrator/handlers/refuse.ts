import type { Classification, OrchestratorRefusal, RefusalCode } from '../types'

export interface RunRefuseInput {
  classification: Classification
  refusalCode?: RefusalCode
  /** Optional override reason from a non-classifier source (e.g. copyright filter). */
  reason?: string
}

/**
 * Synchronous: refusal is metadata-only, no LLM call.
 *
 * Resolves the refusal text in order:
 *   1. explicit `reason` arg (from the copyright filter typically)
 *   2. classification.reason (from the classifier)
 *   3. generic out-of-scope fallback
 */
export function runRefuse(input: RunRefuseInput): OrchestratorRefusal {
  const refusalCode: RefusalCode = input.refusalCode ?? 'out_of_scope'
  const reason =
    input.reason ??
    input.classification.reason ??
    'This request is outside the scope of what I can produce.'
  return {
    refused: true,
    refusalCode,
    reason,
    classification: input.classification,
    latencyMs: 0,
  }
}
