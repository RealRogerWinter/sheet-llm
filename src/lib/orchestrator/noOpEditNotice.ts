import { isNoOpEdit } from '@/lib/music/scoreDiff'
import type { OrchestratorInput, OrchestratorResult } from './types'

/**
 * Surfaced to the user when an edit they asked for ended up changing nothing.
 * Deliberately actionable ("rephrase / name the bars") rather than an apology —
 * the most common cause is an under-specified target the model couldn't pin.
 */
export const NO_OP_EDIT_NOTICE =
  "I couldn't apply that change — try rephrasing it, e.g. name the bars or the specific notes you want changed."

/**
 * SHE-19 follow-up — backstop for the "same old score" bug, shared by both
 * paths that converge on `finalizeDispatchResult`: the native 2-call dispatch
 * path AND the single-call collapse (after its no-op fallback). (The legacy
 * classifier rollback path — only reached with `SL_NEW_TOOL_DISPATCH=0` — does
 * not flow through here and is left untouched.)
 *
 * When a turn INTENDED a structural edit (`dispatchTool` is set — a converse /
 * answer turn leaves it undefined) but the resulting score is identical to the
 * input (Haiku echoed the bars / emitted empty ops, and — for the single-call
 * path — even the 2-call fallback produced no change), there is no proposal or
 * confirmation to show (the ghost-preview no-op gate correctly suppresses one).
 * Without this, the route silently re-renders the unchanged score and the user
 * sees "the same old score" with zero signal the edit failed.
 *
 * Replace the intro text with a clear notice so the chat panel tells the user
 * the edit didn't take. The (unchanged) score is still returned — there is
 * simply nothing new to commit. Mutates `result` in place.
 *
 * No-op when: no `editedScore` (from-scratch generation), no `dispatchTool`
 * (a legitimate converse/answer turn — silence is correct), `requiresConfirmation`
 * is set (a real change is pending the user's accept), or the score actually
 * changed.
 */
export function noticeNoOpEdit(result: OrchestratorResult, input: OrchestratorInput): void {
  if (!input.editedScore) return
  if (result.dispatchTool === undefined) return
  if (result.requiresConfirmation === true) return
  if (!isNoOpEdit(input.editedScore, result.score)) return
  result.introText = NO_OP_EDIT_NOTICE
}
