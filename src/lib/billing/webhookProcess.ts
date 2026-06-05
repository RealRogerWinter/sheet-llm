import type Stripe from 'stripe'
import { and, eq, inArray, lt, notInArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { stripeEvents } from '@/lib/db/schema'
import { getPack } from './packs'
import { creditWallet } from './wallet'

/**
 * Stripe webhook PROCESSING — turns a verified `checkout.session.completed` into
 * a credit grant. The route verifies the signature; this module owns the grant
 * logic + the raw-events inbox + reconciliation. DARK until STRIPE_* keys exist.
 *
 * TRUST MODEL (red-team #5/#6): the ONLY field trusted from the session metadata
 * is `packId`; the credit count and the expected price are RE-DERIVED from the
 * server-side catalog, and the AMOUNT PAID is verified against the pack price, so
 * a tampered session can't grant a $50 pack for a $5 charge. The grant is
 * idempotent on the checkout-session id (so an event redelivery — or a
 * `checkout.session.completed` vs `payment_intent.succeeded` double — credits at
 * most once), AND the inbox is idempotent on the Stripe event id.
 */

type Db = ReturnType<typeof getDb>

const nowSec = (): number => Math.floor(Date.now() / 1000)

const HANDLED_TYPE = 'checkout.session.completed'

export type ProcessOutcome =
  | { status: 'processed'; userId: string; creditsGranted: number }
  | { status: 'ignored'; reason: string }
  | { status: 'failed'; reason: string; userId?: string }

/**
 * Apply ONE event's grant. Pure w.r.t. the inbox (caller records/marks). Trusts
 * only packId from metadata; re-derives credits + verifies the paid amount.
 */
export function processStripeEvent(event: Stripe.Event, db: Db = getDb()): ProcessOutcome {
  if (event.type !== HANDLED_TYPE) return { status: 'ignored', reason: `unhandled_type:${event.type}` }
  const session = event.data.object as Stripe.Checkout.Session
  if (session.payment_status !== 'paid') {
    return { status: 'ignored', reason: `not_paid:${session.payment_status}` }
  }

  const userId = session.client_reference_id ?? session.metadata?.userId ?? null
  if (!userId) return { status: 'failed', reason: 'no_user_ref' }

  const packId = session.metadata?.packId
  const pack = packId ? getPack(packId) : undefined
  if (!pack) return { status: 'failed', reason: `unknown_pack:${packId ?? 'none'}`, userId }

  // Verify what was actually PAID matches the pack. Stripe Tax is exclusive, so
  // our price is the PRE-TAX subtotal; tax sits in amount_total. A coupon / promo
  // code (only if the operator enables one in the dashboard — checkout does NOT
  // set allow_promotion_codes today) REDUCES amount_subtotal and records the cut
  // in total_details.amount_discount, so reconstruct the pre-discount subtotal and
  // check THAT against the pack price. Credits are always the FULL pack — a
  // discount is the operator's marketing cost, not fewer credits. NEVER trust
  // metadata.credits — re-derive from the pack.
  const currency = (session.currency ?? '').toLowerCase()
  if (currency !== 'usd') return { status: 'failed', reason: `bad_currency:${currency}`, userId }
  const subtotal = session.amount_subtotal
  const discount = session.total_details?.amount_discount ?? 0
  if (subtotal == null || discount < 0 || subtotal + discount !== pack.priceUsdCents) {
    return {
      status: 'failed',
      reason: `amount_mismatch:${subtotal}+${discount}!=${pack.priceUsdCents}`,
      userId,
    }
  }

  // Idempotent grant. external_ref = the checkout-session id: stable across event
  // redeliveries and across event TYPES for the same payment, so credits land once.
  const externalRef = `cs:${session.id}`
  let applied: ReturnType<typeof creditWallet>
  try {
    applied = creditWallet(
      {
        userId,
        creditsDelta: pack.totalCredits,
        source: 'stripe',
        externalRef,
        amountMinorUsd: session.amount_total ?? pack.priceUsdCents,
        currency: 'usd',
      },
      db,
    )
  } catch (e) {
    // e.g. the user was erased between checkout and webhook (FK violation) — a
    // permanent failure; the event stays in the inbox for manual reconciliation.
    return { status: 'failed', reason: `grant_error:${e instanceof Error ? e.message : 'unknown'}`, userId }
  }
  if (!applied.applied) {
    // A duplicate grant is a SUCCESS for idempotency; any other refusal is a fault.
    if (applied.reason === 'duplicate') return { status: 'processed', userId, creditsGranted: pack.totalCredits }
    return { status: 'failed', reason: `grant_refused:${applied.reason}`, userId }
  }
  return { status: 'processed', userId, creditsGranted: pack.totalCredits }
}

/**
 * Inbox-aware entry point used by the webhook route. Records the event to the
 * raw-events inbox (idempotent on event id), processes it, and marks the
 * outcome. A previously-terminal event short-circuits as 'duplicate'.
 */
export function handleStripeEvent(
  event: Stripe.Event,
  db: Db = getDb(),
  now: number = nowSec(),
): ProcessOutcome | { status: 'duplicate' } {
  const ins = db
    .insert(stripeEvents)
    .values({ eventId: event.id, type: event.type, status: 'received', payload: JSON.stringify(event), receivedAt: now })
    .onConflictDoNothing()
    .run()
  if (ins.changes !== 1) {
    // Already in the inbox. If it reached a terminal-GOOD state, skip; otherwise
    // (a prior 'received'/'failed') fall through and (re)process — idempotent.
    const prior = db
      .select({ status: stripeEvents.status })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, event.id))
      .get()
    if (prior?.status === 'processed' || prior?.status === 'ignored') return { status: 'duplicate' }
  }

  const outcome = processStripeEvent(event, db)
  markEvent(db, event.id, outcome, now)
  return outcome
}

function markEvent(db: Db, eventId: string, outcome: ProcessOutcome, now: number): void {
  // Status PRECEDENCE: 'processed'/'ignored' are terminal-good. A late 'failed'
  // — e.g. the loser of a concurrent grant race that hit the external_ref UNIQUE
  // after a sibling already granted — must NOT clobber a terminal-good row (the
  // money landed once; the audit trail must not lie). 'failed' only applies while
  // the row is still non-terminal.
  const where =
    outcome.status === 'failed'
      ? and(eq(stripeEvents.eventId, eventId), notInArray(stripeEvents.status, ['processed', 'ignored']))
      : eq(stripeEvents.eventId, eventId)
  db.update(stripeEvents)
    .set({
      status: outcome.status,
      processedAt: now,
      ...('userId' in outcome && outcome.userId ? { userId: outcome.userId } : {}),
      ...(outcome.status === 'processed' ? { creditsGranted: outcome.creditsGranted } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
    })
    .where(where)
    .run()
}

/**
 * RECONCILIATION auto-heal (red-team #5): re-process inbox events that never
 * reached a terminal-good state ('received' = crashed mid-process; 'failed' =
 * transient grant error). Idempotent — the grant's external_ref dedups, so a
 * row that already granted simply re-confirms as 'processed'. Run periodically by
 * the in-process billing scheduler (see src/lib/billing/scheduler.ts, started from
 * instrumentation.ts) + once at boot. Returns counts for observability.
 */
export function reconcileStripeEvents(
  db: Db = getDb(),
  opts: { limit?: number; now?: number } = {},
): { scanned: number; healed: number; stillFailing: number } {
  const now = opts.now ?? nowSec()
  const limit = opts.limit ?? 100
  const stuck = db
    .select({ eventId: stripeEvents.eventId, payload: stripeEvents.payload })
    .from(stripeEvents)
    .where(inArray(stripeEvents.status, ['received', 'failed']))
    .limit(limit)
    .all()
  let healed = 0
  let stillFailing = 0
  for (const row of stuck) {
    let event: Stripe.Event
    try {
      event = JSON.parse(row.payload) as Stripe.Event
    } catch {
      markEvent(db, row.eventId, { status: 'failed', reason: 'corrupt_payload' }, now)
      stillFailing++
      continue
    }
    const outcome = processStripeEvent(event, db)
    markEvent(db, row.eventId, outcome, now)
    if (outcome.status === 'processed' || outcome.status === 'ignored') healed++
    else stillFailing++
  }
  return { scanned: stuck.length, healed, stillFailing }
}

const DEFAULT_RETENTION_DAYS = 90

function envRetentionDays(): number {
  const n = Number(process.env.SL_STRIPE_EVENT_RETENTION_DAYS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

/**
 * Inbox RETENTION prune (PR-13). The stripe_events inbox keeps the RAW Stripe
 * payload (customer email, billing metadata) for idempotency + reconciliation +
 * audit. Once an event reaches a terminal-GOOD state ('processed' / 'ignored')
 * AND has aged past the retention window it serves neither purpose — and holding
 * raw customer PII forever is a GDPR liability — so drop it. NEVER prune
 * 'received' / 'failed' (the reconciliation reaper still needs those), and never
 * touch the canonical financial record (credit_purchases, retained separately).
 * Operator-tunable window via SL_STRIPE_EVENT_RETENTION_DAYS (default 90 days).
 * Rows with a NULL processed_at are non-terminal and excluded by the comparison.
 * Returns the number of rows pruned.
 */
export function pruneStripeEvents(
  db: Db = getDb(),
  opts: { retentionDays?: number; now?: number } = {},
): number {
  const now = opts.now ?? nowSec()
  const retentionDays = opts.retentionDays ?? envRetentionDays()
  const cutoff = now - retentionDays * 86_400
  const res = db
    .delete(stripeEvents)
    .where(
      and(inArray(stripeEvents.status, ['processed', 'ignored']), lt(stripeEvents.processedAt, cutoff)),
    )
    .run()
  return res.changes
}
