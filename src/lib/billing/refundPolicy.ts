import type { OrchestratorFinalStatus } from '@/lib/orchestrator/types'

/**
 * Refund POLICY — pure decision logic mapping a finished generation's outcome
 * to a refund decision. Encodes the locked product rule (interview 2026-06-04):
 * auto-refund OUR failures up to a per-failure cap; COST-SPLIT (~50%) a
 * large/unusual high-cost failure (we ate real money — the user shares it);
 * NEVER refund a user-initiated abort or a delivered result. The
 * wallet.refund() primitive enforces the per-day abuse ceiling and moves the
 * money; this function only decides whether and how much.
 *
 * DARK: PR-7 calls this from the paywall settle path. No money moves here.
 */

/** Largest single auto-refund (credits). A normal generation charges ~23–75
 *  credits, an Opus "advanced" one more — this covers a full refund of one
 *  expensive call while capping abuse. Kept well below
 *  DAILY_REFUND_MAX_CREDITS. Operator-tunable; re-derive from measured data. */
export const PER_FAILURE_REFUND_CAP_CREDITS = 150

/** Our RAW cost above which a failure is "large/unusual" → cost-SPLIT instead
 *  of a full refund. 300_000 µUSD = $0.30, above a normal cold generation
 *  (~$0.16) — flags the expensive multi-call sectional failures. */
export const COST_SPLIT_THRESHOLD_MICRO_USD = 300_000

/** Fraction of the charge returned on a cost-split (we absorb the rest). */
export const COST_SPLIT_REFUND_RATIO = 0.5

export interface OutcomeInput {
  /** orchestrator_turns.final_status for the turn. */
  finalStatus: OrchestratorFinalStatus
  /** The request's AbortSignal fired (user navigated away / cancelled). We
   *  NEVER refund this — they chose to stop a call that was working. */
  userAborted?: boolean
  /** What we actually charged (settled). 0 when the hold was released and never
   *  settled — there is nothing to refund. */
  creditsCharged: number
  /** Our raw Anthropic cost on the call (µUSD), for the cost-split decision. */
  costMicroUsd?: number
}

export type RefundDecision =
  | { refund: false; reason: 'nothing_charged' | 'user_aborted' | 'delivered' }
  | { refund: true; kind: 'full' | 'cost_split'; credits: number; reason: 'error' | 'refused' | 'cost_split' }

/**
 * Decide the refund for a finished turn. Returns `{ refund: false }` for the
 * common no-refund cases (success, abort, never-charged) so the caller can skip
 * touching the wallet entirely.
 */
export function classifyRefund(o: OutcomeInput): RefundDecision {
  // Nothing was charged (hold released, never settled) → nothing to return.
  if (o.creditsCharged <= 0) return { refund: false, reason: 'nothing_charged' }
  // The user chose to stop a working call — never refund an abort.
  if (o.userAborted) return { refund: false, reason: 'user_aborted' }
  // Delivered a result (an applied edit, or a conversational fall-through
  // reply) — the user got value.
  if (o.finalStatus === 'ok' || o.finalStatus === 'fell_through') {
    return { refund: false, reason: 'delivered' }
  }

  // 'error' (our exception / provider / timeout) or 'refused' (we declined
  // after a charge somehow settled) — make it right.
  const cost = o.costMicroUsd ?? 0
  if (cost >= COST_SPLIT_THRESHOLD_MICRO_USD) {
    const credits = Math.min(
      Math.ceil(o.creditsCharged * COST_SPLIT_REFUND_RATIO),
      PER_FAILURE_REFUND_CAP_CREDITS,
    )
    return { refund: true, kind: 'cost_split', credits, reason: 'cost_split' }
  }
  const credits = Math.min(o.creditsCharged, PER_FAILURE_REFUND_CAP_CREDITS)
  return { refund: true, kind: 'full', credits, reason: o.finalStatus }
}
