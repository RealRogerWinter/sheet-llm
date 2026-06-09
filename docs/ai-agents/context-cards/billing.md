---
title: Billing & Prepaid Credits — Context Card
subsystem: billing
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 4453d42
source_paths:
  - src/lib/metering/pricing.ts
  - src/lib/metering/usageMeter.ts
  - src/lib/billing/valueTier.ts
  - src/lib/billing/wallet.ts
  - src/lib/billing/refundPolicy.ts
  - src/lib/billing/freePiece.ts
  - src/lib/billing/packs.ts
  - src/lib/billing/stripe.ts
  - src/lib/billing/checkout.ts
  - src/lib/billing/checkoutRateLimit.ts
  - src/lib/billing/webhookProcess.ts
  - src/lib/billing/scheduler.ts
  - src/lib/billing/surface.ts
  - src/lib/billing/transactions.ts
  - src/app/api/chat/route.ts
related:
  - orchestrator
  - auth-gdpr
  - persistence-db
---

# Billing — Context Card

Hosted-only prepaid-credit paywall. **Entirely dark by default.** Self-host = BYOK
(own `ANTHROPIC_API_KEY`, free, no credits). Deep doc: [`billing.md`](../../subsystems/billing.md).

## Master switches
- `SL_PAID_GENERATION` — the credit paywall on `/api/chat` (`auth/account.ts`).
- `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) — money-in; every `/api/billing/*` 404s without it (`billing/stripe.ts`).
- `SL_ADVANCED_COMPOSER` — Opus "Advanced Composer" Pro toggle.
- Surface gate: `isBillingSurfaceEnabled()` = `isStripeEnabled() || isPaidGenerationEnabled()` (`billing/surface.ts`).

## Key files (by stage)
| Stage | File | Exports |
| --- | --- | --- |
| Meter | `usageMeter.ts`, `pricing.ts` | `runWithUsageMeter`, `recordProviderCall`, `billableCostUsd` (throws on unknown model) |
| Price | `valueTier.ts` | `costToCredits`, `markupForKind` (2.5× gen / 1.2× edit), `worstCaseHoldCredits`, `generationHoldCredits`, `maxGenerationHoldCredits`, `freePieceBudgetCredits` |
| Wallet | `wallet.ts` | `ensureWallet`, `placeHold`, `settleHold`, `releaseHold`, `refund`, `creditWallet`, `reapExpiredHolds`, `getWallet` |
| Refund | `refundPolicy.ts` | `classifyRefund` (policy) → `wallet.refund` (atomic, per-day ceiling) |
| Free piece | `freePiece.ts` | `isFreePieceEligible`, `reserveFreePiece`→token, `releaseFreePiece(userId, token)` |
| Stripe | `packs.ts`, `stripe.ts`, `checkout.ts`, `checkoutRateLimit.ts`, `webhookProcess.ts` | `getPack`, `isStripeEnabled`, `buildCheckoutSessionParams`, `checkCheckoutRate`, `handleStripeEvent`/`reconcileStripeEvents`/`pruneStripeEvents` |
| Scheduler | `scheduler.ts` | `runBillingJanitorsOnce`, `startBillingScheduler` (from `instrumentation.ts`) |
| UI | `surface.ts`, `transactions.ts`, `WalletSettings.tsx` | `isBillingSurfaceEnabled`, `listRecentTransactions` |
| Paywall wiring | `app/api/chat/route.ts` `handleChat` | hold → run → settle/refund |

## Load-bearing invariants (don't break)
- **No money lost / no overdraft**: settle reads metered ACTUALS; `settleHold` caps debit at the hold; solvency CHECK enforces `held <= balance`, `balance >= 0`.
- **Single charge site**: NO `AbortSignal` into the orchestrator → `done`/abort settles once. A user abort is CHARGED, never refunded. Don't wire `cancel()`→stop-generation (would free a paid gen via the `finally` release).
- **Fail-CLOSED**: insufficient credits / wallet-DB fault → refuse, never serve uncharged. Paid request never served by the uncharged legacy path.
- **Free piece** = charge-SKIP off the wallet (never a credit grant → no refund-farming); reserved pre-dispatch, owner-token-scoped release.
- **Webhook** trusts only `packId`; credits re-derived; `amount_subtotal === pack price` (it's PRE-discount, so coupons just cut `amount_total`); `amount_total > 0`. Double idempotency (inbox event-id PK + `external_ref` UNIQUE). **Reconcile is the only heal for a paid-but-not-granted webhook** (transient fail returns 200 → no Stripe retry).
- `isTierOverrideAllowed()` gates `debug.orchestrator`/`debug.generationTier` (paywall-bypass otherwise).
- `SL_BOUNDED_GEN=0` must not open the unbounded sectional path for free (gated on `policyFor(tier).allowSectional`).

## When editing X, also update Y
- New users-FK'd table → add it to `buildUserExport` (`gdpr/exportUser.ts`) or the FK-completeness guard test fails.
- New billing env flag → `docs/reference/env-flags.md` (Billing section) + this card's source_paths.
- New schema migration → bump the synthetic `when`, add a drift-guard to `creditTablesMigration.test.ts` (last = 0015).
- Touching the charge math → re-read `valueTier.ts` + the paywall integration tests; spawn a money-safety review.

## Migrations: 0009–0015
credit tables (0009) → solvency/idempotency refinements (0010) → refund engine (0011) → stripe_events inbox (0012) → orchestrator_turns request index (0013) → free_full_piece_used_at (0014) → free_full_piece_claim_token (0015).

**Do NOT enable** until the launch gates land (Stripe Tax/Radar/3DS, attorney memo, Anthropic ToS) — see [`billing.md` § Launch](../../subsystems/billing.md#launch--operator-checklist).
