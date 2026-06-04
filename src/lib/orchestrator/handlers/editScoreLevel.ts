import { transformScore } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import type { Score } from '@/lib/music/types'
import type { Classification, OrchestratorResult } from '../types'

export class EditHandlerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditHandlerError'
  }
}

export interface RunEditScoreLevelInput {
  classification: Classification
  editedScore: Score | undefined
}

const ALLOWED_KINDS = new Set([
  'changeKey',
  'changeMeter',
  'changeTempo',
  'changeTitle',
  'changeClef',
])

/**
 * Apply the classifier's score_level_ops to the user's editedScore.
 * Pure deterministic — no LLM call.
 *
 * Transactional: ops are applied sequentially to a JSON-cloned copy
 * of the input score via `transformScore` (NO per-step validation).
 * Score-level ops (key/meter/tempo/title) never invalidate a score's
 * note content, so skipping per-step validation is safe and avoids
 * tripping on mid-edit semantic invalidity that the user expects the
 * server to tolerate.
 *
 * Final score is validated once at the end. On failure or on an
 * op with a non-whitelisted kind, EditHandlerError surfaces the
 * offending op index; the orchestrator falls through to legacy.
 */
export async function runEditScoreLevel(
  input: RunEditScoreLevelInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  const { classification, editedScore } = input

  if (!editedScore) {
    throw new EditHandlerError(
      'edit_score_level requires a current score; none was sent with the request',
    )
  }
  const ops = classification.score_level_ops ?? []
  if (ops.length === 0) {
    throw new EditHandlerError('edit_score_level emitted no operations')
  }

  let next: Score = JSON.parse(JSON.stringify(editedScore))
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (!ALLOWED_KINDS.has(op.kind)) {
      throw new EditHandlerError(
        `edit_score_level op #${i} has disallowed kind "${op.kind}"`,
      )
    }
    try {
      next = transformScore(next, op)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      throw new EditHandlerError(`edit_score_level op #${i} (${op.kind}) failed: ${msg}`)
    }
  }

  // Final validation — accept mid-edit semantic invalidity on the
  // input, reject post-edit semantic invalidity. If only score-level
  // changes were applied to an already-invalid score, the result is
  // still invalid; that's a legitimate fall-through (the legacy LLM
  // path can repair it).
  try {
    validateScore(next)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new EditHandlerError(
        `edit_score_level produced an invalid score (likely pre-existing mid-edit state): ${e.message}`,
      )
    }
    throw e
  }

  return {
    score: next,
    classification,
    model: null,
    latencyMs: Date.now() - t0,
  }
}
