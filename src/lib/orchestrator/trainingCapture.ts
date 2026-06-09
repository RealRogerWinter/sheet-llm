import { createHash, randomUUID } from 'node:crypto'
import { isFlagEnabled } from '@/lib/env/flag'
import { getDb } from '@/lib/db'
import { trainingPairs } from '@/lib/db/schema'

/**
 * SHE-18 PR4 — training-data CONSENT CAPTURE (hosted-only).
 *
 * `SL_CAPTURE_TRAINING` gates whether a turn is marked for inclusion in the
 * training corpus. It is OFF by default, so self-hosted / local installs never
 * write a `training_pairs` row even though they run the same `orchestrator_turns`
 * telemetry — the marker table is the consent boundary that keeps captured
 * training data to sheetllm.com only. Read fresh per call (the canonical
 * `isFlagEnabled` discipline) so an operator flip takes effect without redeploy.
 *
 * ⚠️ Building/running this capture is decoupled from USING the data: per the
 * SHE-18 decision, exported data must not feed any training run until a ToS /
 * legal review clears it. This only records WHICH turns are eligible.
 */
export function isCaptureTrainingEnabled(): boolean {
  return isFlagEnabled('SL_CAPTURE_TRAINING')
}

/**
 * Opaque, non-reversible session key for dedup/grouping in the export. The raw
 * session id (and therefore the user) is never persisted in `training_pairs`.
 * `SL_CAPTURE_SALT` should be set per hosted deployment so the same session
 * can't be linked across unrelated exported datasets by anyone who lacks the
 * salt; with it unset we still hash (a session id is itself a random UUID), but
 * an operator running real capture should set it (documented in .env.example).
 */
function hashSession(sessionId: string): string {
  const salt = process.env.SL_CAPTURE_SALT ?? ''
  return createHash('sha256').update(`${salt}:${sessionId}`).digest('hex')
}

/**
 * When capture is enabled, mark `turnId` (a freshly-written orchestrator_turns
 * row) as consented for training. Idempotent (unique turn_id → ON CONFLICT DO
 * NOTHING). Best-effort: a consent-marker write must never disrupt the turn, so
 * it both checks the flag and swallows DB errors. Stores NO content/identifier
 * — only the turn FK + a salted session hash + the capture timestamp.
 */
export function captureTrainingPair(
  db: ReturnType<typeof getDb>,
  args: { turnId: string; sessionId: string },
): void {
  if (!isCaptureTrainingEnabled()) return
  try {
    db.insert(trainingPairs)
      .values({
        id: randomUUID(),
        turnId: args.turnId,
        sessionHash: hashSession(args.sessionId),
        // ms, to share a clock with orchestrator_turns.created_at.
        capturedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run()
  } catch {
    // best-effort: never disrupt the request over a consent-marker write
  }
}
