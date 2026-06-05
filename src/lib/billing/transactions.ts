import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { creditPurchases, usageLedger } from '@/lib/db/schema'

/**
 * Read-side WALLET ACTIVITY view (PR-12 wallet UI). Merges the two money tables
 * that move a user's credit balance into one reverse-chronological feed:
 *   - `credit_purchases` (money IN: Stripe top-ups, promo grants, refunds) —
 *     `creditsDelta` is already signed (+grant / -reversal).
 *   - `usage_ledger`     (credits SPENT on generations/edits, and refunds OF
 *     those) — `creditsCharged` is +on a charge, NEGATIVE on a refund row, so
 *     the wallet effect is `-creditsCharged`.
 *
 * Only `settled` purchases are shown — a `pending`/`reversed` row never net-moved
 * the balance, so including it would not reconcile with the displayed total.
 *
 * Read-only and per-user; no money mutates here. The route layer
 * (`/api/billing/transactions`) authenticates + feature-gates before calling.
 */

type Db = ReturnType<typeof getDb>

/** Coarse category for display + iconography in the wallet UI. */
export type WalletTransactionType =
  | 'purchase' // a paid Stripe top-up
  | 'generation' // credits spent on a from-scratch / whole-score generation
  | 'edit' // credits spent on an edit
  | 'refund' // credits returned (our failure, or a reversed purchase)
  | 'adjustment' // a promo / manual grant

export interface WalletTransaction {
  id: string
  /** Signed effect on the wallet balance: +added (purchase/refund/grant), -spent. */
  creditsDelta: number
  type: WalletTransactionType
  /** Short human-readable label (no PII, no raw error strings). */
  description: string
  /** Money paid, integer USD cents — only for a paid purchase; null otherwise. */
  amountMinorUsd: number | null
  /** Unix seconds. */
  createdAt: number
}

/** Default page size — recent activity, not a full export (that's the GDPR path). */
export const DEFAULT_TRANSACTIONS_LIMIT = 50
const MAX_TRANSACTIONS_LIMIT = 200

function purchaseType(source: string): WalletTransactionType {
  if (source === 'stripe') return 'purchase'
  if (source === 'refund') return 'refund'
  return 'adjustment' // 'promo' | 'manual' | any future app-validated source
}

function purchaseDescription(source: string, creditsDelta: number): string {
  if (source === 'stripe') return creditsDelta >= 0 ? 'Credit purchase' : 'Purchase reversal'
  if (source === 'refund') return 'Refund'
  if (source === 'promo') return 'Promotional credit'
  return 'Account adjustment' // 'manual'
}

function ledgerType(kind: string): WalletTransactionType {
  if (kind === 'chat_edit') return 'edit'
  if (kind === 'refund') return 'refund'
  return 'generation' // 'chat_generate' and any future generation kind
}

function ledgerDescription(kind: string, reason: string | null): string {
  if (kind === 'chat_edit') return 'Edit'
  if (kind === 'refund') return reason ? `Refund (${reason})` : 'Refund'
  return 'Generation' // 'chat_generate'
}

/**
 * Recent wallet activity for `userId`, newest first, at most `limit` rows
 * (clamped to [1, {@link MAX_TRANSACTIONS_LIMIT}]; default
 * {@link DEFAULT_TRANSACTIONS_LIMIT}). Pulls up to `limit` from EACH table then
 * merges + re-sorts + caps, so the result is the true top-N across both.
 */
export function listRecentTransactions(
  userId: string,
  limit: number = DEFAULT_TRANSACTIONS_LIMIT,
  db: Db = getDb(),
): WalletTransaction[] {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_TRANSACTIONS_LIMIT) : DEFAULT_TRANSACTIONS_LIMIT

  const purchases = db
    .select({
      id: creditPurchases.id,
      source: creditPurchases.source,
      creditsDelta: creditPurchases.creditsDelta,
      amountMinorUsd: creditPurchases.amountMinorUsd,
      status: creditPurchases.status,
      createdAt: creditPurchases.createdAt,
    })
    .from(creditPurchases)
    .where(eq(creditPurchases.userId, userId))
    .orderBy(desc(creditPurchases.createdAt))
    .limit(cap)
    .all()
    .filter((p) => p.status === 'settled')
    .map(
      (p): WalletTransaction => ({
        id: p.id,
        creditsDelta: p.creditsDelta,
        type: purchaseType(p.source),
        description: purchaseDescription(p.source, p.creditsDelta),
        amountMinorUsd: p.amountMinorUsd ?? null,
        createdAt: p.createdAt,
      }),
    )

  const ledger = db
    .select({
      id: usageLedger.id,
      kind: usageLedger.kind,
      reason: usageLedger.reason,
      creditsCharged: usageLedger.creditsCharged,
      createdAt: usageLedger.createdAt,
    })
    .from(usageLedger)
    .where(eq(usageLedger.userId, userId))
    .orderBy(desc(usageLedger.createdAt))
    .limit(cap)
    .all()
    .map(
      (l): WalletTransaction => ({
        id: l.id,
        creditsDelta: -l.creditsCharged, // a charge debits; a refund row (negative) credits back
        type: ledgerType(l.kind),
        description: ledgerDescription(l.kind, l.reason ?? null),
        amountMinorUsd: null,
        createdAt: l.createdAt,
      }),
    )

  return [...purchases, ...ledger].sort((a, b) => b.createdAt - a.createdAt).slice(0, cap)
}
