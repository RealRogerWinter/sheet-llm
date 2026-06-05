---
title: Billing & Prepaid Credits
subsystem: billing
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-05
verified_against: 8227618
source_paths:
  - src/lib/billing/pricing.ts
  - src/lib/billing/usageMeter.ts
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

# Billing & Prepaid Credits

The **prepaid-credits "Pro plan"**: a hosted-only paywall that meters the real
Anthropic cost of a generation, charges cost-plus from a credit wallet, and tops
the wallet up via Stripe. It is **entirely dark by default** and **must not be
enabled until the launch gates land** (see [Launch / operator checklist](#launch--operator-checklist)).
Self-hosting is the BYOK path — bring your own `ANTHROPIC_API_KEY`, generate for
free, and never touch any of this.

> **One invariant above all:** a paid call can never lose money or overdraft. We
> meter ACTUAL cost, charge `max(metered × markup, fail-closed fallback)`, and a
> hold caps the debit so `balance >= 0` and `held <= balance` always hold.

## Money posture (locked decisions)

- **Charge = cost-plus on metered cost**: `2.5×` generations, `1.2×` edits. Value
  tiers `{edit 5, standard 25, full 60, opus 150}` are display/quote + fail-closed
  fallback anchors, NOT the happy-path charge. 1 credit = 1¢.
- **Free tier** (no account / not Pro): bounded ≤4-bar generation, off the money
  path entirely. Plus a **one-time free full piece** per VERIFIED account — a
  charge-SKIP (never a credit grant, which would enable refund-farming).
- **Refund** = auto-refund OUR failures (error/timeout/our-validation-fail) up to
  a per-day count AND credit ceiling; NEVER refund a user abort or a delivered
  result.
- **Credits never expire.** Auto-refill is opt-in (no subscription).
- **Advanced Composer** = a Pro toggle that routes the heavy compositional call to
  Opus; self-funding at the same 2.5× on the higher metered cost (no premium markup).

## Entry points

| Surface | Entry | Notes |
| --- | --- | --- |
| Paywall (spend) | `src/app/api/chat/route.ts` `handleChat` | hold → run → settle/refund; gated on `SL_PAID_GENERATION` |
| Buy credits | `src/app/api/billing/{packs,checkout}/route.ts` | gated on `STRIPE_SECRET_KEY` (404 otherwise) |
| Grant credits | `src/app/api/billing/webhook/route.ts` | Stripe webhook; verifies signature → grants |
| Wallet UI | `src/components/billing/WalletSettings.tsx` + `/api/billing/{wallet,transactions}` | `/settings` → Credits; gated on `isBillingSurfaceEnabled()` |
| Janitors | `src/lib/billing/scheduler.ts` via `src/instrumentation.ts` | boot sweep + interval |

## Data flow

```
                      ┌─────────────── /api/chat handleChat ───────────────┐
 request ─▶ identity ─▶ quota(fail-open) ─▶ HOLD(fail-closed) ─▶ run() ─▶ SETTLE / refund
                                              │ placeHold            │        │
                                              ▼ worst-case           ▼ meter  ▼ actual cost-plus
                                         credit_wallets         usageMeter   usage_ledger
                                          (balance/held)          (ALS)      (immutable)

 buy:  /packs ─▶ /checkout (Stripe Checkout) ─▶ [Stripe] ─▶ webhook ─▶ creditWallet ─▶ credit_purchases
 heal: scheduler ─▶ reconcileStripeEvents (stuck inbox rows) + reapExpiredHolds + prune
```

### 1. Metering — what a call actually cost

`recordProviderCall` fires at the Anthropic provider chokepoints and accumulates
into a **request-scoped `AsyncLocalStorage` meter** (`usageMeter.ts`,
`runWithUsageMeter(requestId, …)`), priced by `pricing.ts` (`billableCostUsd`
THROWS on an unknown model — a paid call is never silently un-metered). `run()`
wraps itself in the meter; the streamed sectional/converse paths are wrapped in
the route. Non-streaming turns settle off `orchestrator_turns.cost_micro_usd`
(by `request_id`); streaming turns settle off the in-memory meter snapshot.

### 2. Pricing → charge — `valueTier.ts`

`costToCredits(µUSD, markup) = max(1, ceil(µUSD × markup / 10000))`. Markup by
kind: `2.5×` generation, `1.2×` edit (`markupForKind`). A NULL/0/implausible cost
on a DELIVERED turn fails closed to the flat fallback (standard = 25cr).
Hold sizing (fork-b, available-balance-bound): `generationHoldCredits(available,
maxOut, advanced) = clamp(available, [worstCaseHoldCredits floor, cap])`; cap =
`maxGenerationHoldCredits()` (`SL_MAX_GEN_HOLD_CREDITS`). The free piece is bounded
by `freePieceBudgetCredits()` (`SL_FREE_PIECE_BUDGET_CREDITS`) since it has no hold.

### 3. Wallet engine — `wallet.ts` (the atomic primitives)

Integer credits, every mutation one synchronous better-sqlite3 transaction with
**guard-in-the-write**, backed by the `credit_wallets_solvent` CHECK
(`balance >= 0 AND held >= 0 AND held <= balance`). Lifecycle:
`ensureWallet → placeHold (reserve, fail-closed) → settleHold (debit ACTUAL,
release rest) | releaseHold (failure: give back, no debit)`. `settleHold`'s debit
is `min(creditsCharged, hold.credits)` — overdraft is impossible; an over-hold
flags `overHold` and we absorb the shortfall. Top-ups go through `creditWallet`
(idempotent on `externalRef`). `refund()` writes a NEGATIVE ledger row (double
entry) bounded by per-day count + credit ceilings (`refund_counters`).
`reapExpiredHolds` releases holds stranded by a crash.

### 4. Stripe money-in — `packs/stripe/checkout/webhookProcess.ts`

Packs `$5/$10/$20/$50` (+escalating bonus). Checkout is eligibility-gated
(claimed + email-verified) and rate-limited (`checkoutRateLimit.ts`). The webhook
**trusts only `packId`** from metadata: credits are re-derived from the pack and
the **paid amount is verified** (`amount_subtotal === pack price`, `amount_total
> 0`). `amount_subtotal` is the PRE-discount list price, so a coupon is handled
automatically (it only reduces `amount_total`). Double idempotency: the
`stripe_events` inbox (PK on event id) + the grant (`credit_purchases.external_ref`
= `cs:<session id>`, UNIQUE).

### 5. Reconciliation + janitors — `scheduler.ts`

The deploy is a single long-lived container (better-sqlite3 + Litestream), so
janitors run **in-process** (boot sweep + `.unref()`'d interval from
`instrumentation.ts`), gated per-subsystem. **`reconcileStripeEvents` is
load-bearing**: a webhook whose grant transiently fails still returns `200` to
Stripe (the inbox absorbs it), so Stripe will NOT retry — reconcile is the ONLY
automatic heal for a paid-but-not-granted purchase. Also: `pruneStripeEvents`
(retention), `reapStaleCheckoutBuckets`.

## Invariants & gotchas

- **No `AbortSignal` is threaded into the orchestrator** — the pump runs to
  completion even on client disconnect, so `done`/abort is the SINGLE charge site.
  A real user abort is CHARGED (never refunded); abort-before-done free-gen abuse
  is structurally impossible. Wiring `cancel()` → stop-generation would let
  `finally` release the hold = a free paid gen. Invariant comments are pinned.
- **Fail-CLOSED on the money path**: insufficient balance / a wallet or DB fault
  during hold placement → refuse (402 / 500), never serve an uncharged generation.
  A paid request can never be served by the uncharged legacy path (universal
  backstop in `handleChat`).
- **Tier-override debug fields** (`debug.orchestrator`, `debug.generationTier`)
  stay gated by `isTierOverrideAllowed()` — honoring them in prod is a paywall
  bypass (a prior security review caught this).
- **Free piece** is a charge-SKIP keyed on the verified account, reserved
  pre-dispatch (atomic, owner-token-scoped `releaseFreePiece`); it NEVER touches
  the wallet.
- **`SL_BOUNDED_GEN=0`** (bounded-handler off-switch) must not open the unbounded
  sectional loop for free — the sectional stream is gated on the tier's
  `allowSectional`.
- ESLint forbids hard-coded `claude-opus` literals in `orchestrator/**` + `route.ts`
  (model class flows through `resolveModelClass`).

## GDPR

- **Access (Art. 15):** `buildUserExport` (`src/lib/gdpr/exportUser.ts`) includes
  the wallet, usage ledger, purchases, holds, refund counters, and the user's
  Stripe events. **Redacted:** Stripe-internal ids (`external_ref`, the Stripe
  event id + raw payload) and our raw cost basis (`cost_micro_usd`). A
  `foreign_key_list` guard test fails if a future users-FK'd table escapes the
  export.
- **Erasure (Art. 17):** the five users-FK'd credit tables cascade-delete with the
  account. `stripe_events` has NO users FK and is RETAINED past erasure as a
  financial/tax record (lawful basis, Art. 17(3)(b)); the erasure-time
  redaction-vs-retain decision for its payload is gated on the launch attorney memo.

## Launch / operator checklist

The product ships dark. Before flipping `SL_PAID_GENERATION`, an operator must
complete these **out-of-band** gates (none are code):

1. **Stripe account + keys**: set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`;
   register the webhook endpoint (`/api/billing/webhook`) for
   `checkout.session.completed`.
2. **Stripe Tax**: enable Tax in the dashboard; the default product tax code is
   `txcd_10000000` (override per-jurisdiction with `SL_STRIPE_TAX_CODE`).
3. **Stripe Radar + 3DS** (card-fraud controls, the front line — the in-app
   checkout rate-limit is one soft layer behind these):
   - Turn on **Radar** rules; raise the risk threshold for blocking; enable the
     "block if CVC/postal fails" rules.
   - Require **3D Secure** on elevated-risk payments (Radar rule: *Request 3DS when
     risk level is elevated/highest*). Closed-loop credits + a heavy-model
     multiplier make fresh-card testing unprofitable, but 3DS stops most of it.
   - Watch **fresh-card velocity** + Opus spend; cap auto-refill (auto-refill ships
     default-OFF).
4. **Attorney memo**: confirm closed-loop credits are a **service entitlement with
   no cash value** (not stored value / e-money), and the `stripe_events` retention
   basis.
5. **Anthropic ToS**: confirm a paid end-user product on the shared key (incl. Opus
   routing) is permitted.

Then set `SL_PAID_GENERATION=1` (and `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`)
and redeploy. The flag is read fresh per request; the janitor scheduler starts at
boot when a billing subsystem is enabled.

## Env flags

All billing flags (defaults + read sites) live in
[`env-flags.md` → Billing & paywall](../reference/env-flags.md#billing--paywall-prepaid-credits).
The master switches: `SL_PAID_GENERATION` (paywall), `STRIPE_SECRET_KEY` (buy +
surface), `SL_ADVANCED_COMPOSER` (Opus toggle).

## Testing

`tests/unit/billing/*` (pricing, valueTier, wallet, refundPolicy, freePiece,
checkoutRateLimit, webhookProcess, scheduler) + `tests/integration/api-chat-paywall*.test.ts`
(non-streaming + streaming hold/settle/refund, fail-closed), `api-billing-webhook.test.ts`
(route + concurrency + the 200-on-failed-grant contract), `api-me-gdpr.test.ts`
(export redaction + the FK completeness guard), `tests/unit/db/creditTablesMigration.test.ts`
(schema drift-guard, migrations 0009–0015).

## Related files / See also

- [`docs/reference/env-flags.md`](../reference/env-flags.md) — every billing flag.
- [`docs/subsystems/auth-gdpr.md`](auth-gdpr.md) — the export/erasure endpoints.
- [`docs/subsystems/persistence-db.md`](persistence-db.md) — the credit-table schema.
- `src/lib/billing/wallet.ts` — the atomic money primitives (start here).
- `src/lib/billing/README.md` is not present; this doc is the canonical reference.
