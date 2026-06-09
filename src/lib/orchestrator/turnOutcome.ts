import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { orchestratorTurns } from '@/lib/db/schema'

/**
 * The user's explicit decision on a turn's emitted score (SHE-18 PR2).
 *
 * - `accepted`   — an explicitly-confirmed turn: the session head was advanced
 *                  to the emitted version through the confirmation modal
 *                  (replacement gate or ghost-preview proposal).
 * - `reverted`   — the emitted version was rejected at the confirmation modal,
 *                  or undone later via the revert route.
 * - `superseded` — DERIVED at export time (an un-accepted candidate that a
 *                  later turn replaced); never written by the live routes.
 *
 * Note on `NULL` (the COMMON case): a normal, non-gated turn advances the head
 * inside `appendMessages` without a modal, so it is never routed through
 * confirm-replacement and keeps `outcome = NULL`. NULL therefore means "no
 * explicit decision" — i.e. *implicitly kept* (the user left it in place and
 * never undid it). For training-data filtering (PR5 export) the usable set is
 * `outcome IS NULL OR outcome = 'accepted'`; `reverted`/`superseded` are the
 * excluded negatives. (So the export filter is "not reverted/superseded", NOT
 * "= accepted" — `accepted` alone is a low-frequency, gated-only label.)
 *
 * The allowed set is enforced at the DB layer by a column CHECK
 * (migration 0016).
 */
export type TurnOutcome = 'accepted' | 'reverted' | 'superseded'

/**
 * Persist `outcome` onto the orchestrator turn that emitted `scoreVersionId`
 * (`orchestrator_turns.after_score_version_id`).
 *
 * Why key on the score version, not the turn id: the turn id is minted
 * inside `recordTurn` and never returned, and the `requestId` that keyed the
 * turn is not surfaced to the client — so neither is reachable from the
 * confirm-replacement / revert routes, which run as separate HTTP requests
 * after the turn completes. The emitted score version IS reachable there
 * (`candidateVersionId` / the prior head), and `afterScoreVersionId` is the
 * column that records it, so it is the join key.
 *
 * Best-effort telemetry: a failure here must never break the user-facing
 * decision, so DB errors are swallowed (mirrors `recordTurn`'s posture).
 * Matching no row is a normal no-op — e.g. reverting away from a score that
 * came from a manual edit or an earlier `revert` row, neither of which has
 * an orchestrator turn. Last write wins: a later undo overwrites an earlier
 * `accepted`, which is the stronger training-data-quality signal.
 */
export async function recordTurnOutcome(
  scoreVersionId: string,
  outcome: TurnOutcome,
): Promise<void> {
  try {
    // The WHERE is unfiltered by session, but it can only ever match ONE row
    // by construction: each emitted score version is a fresh unique UUID, and
    // `linkTurnScoreVersion` links exactly one turn per minted version. So
    // this is a single-row UPDATE in practice (no fan-out, no cross-session
    // reach — the version belongs to exactly one session).
    // better-sqlite3 is synchronous; the async signature future-proofs the
    // call sites (routes already `await` it) without changing behavior.
    getDb()
      .update(orchestratorTurns)
      .set({ outcome })
      .where(eq(orchestratorTurns.afterScoreVersionId, scoreVersionId))
      .run()
  } catch {
    // best-effort: never disrupt the request over a telemetry write
  }
}
