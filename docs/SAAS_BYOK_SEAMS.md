---
title: SaaS / BYOK Seams & the OSS↔SaaS Layering Invariant
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-10
verified_against: 8c99094
source_paths:
  - src/lib/env/flag.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/generationTier.ts
  - src/lib/orchestrator/dailyQuota.ts
  - src/lib/orchestrator/byokRateLimit.ts
  - src/lib/auth/account.ts
  - src/lib/billing/stripe.ts
related:
  - orchestrator
  - auth-gdpr
  - billing
---

# SaaS / BYOK Seams & the OSS↔SaaS Layering Invariant

sheet-llm ships as both a **fully-OSS, BYOK/local app** and a **hosted SaaS**
that resells tokens. The two share one codebase; the difference is entirely
**runtime configuration** (env flags) plus a small set of fail-closed seams.
This doc is the canonical reference for those seams and the layering rules that
keep the OSS edition uncapped while the hosted surface stays safe. It is part of
the SHE-8 multi-platform hardening.

## The layering invariant (do not violate)

1. **OSS runs uncapped & unpaywalled.** The platform-portable core
   (`src/lib/{music,abc,providers,orchestrator}`, `metering`, `http`) must
   impose no paywall, quota, or credit logic of its own. Scope/ceiling decisions
   arrive as **injected config** (the orchestrator's `TierPolicy`), not imported
   policy — an absent policy means *no restrictions*.
2. **The SaaS surface is fail-closed.** Every SaaS feature is **OFF by default**
   and only enabled by an explicit operator env flag. A missing/513 backend, an
   unset key, or an unrecognized flag value must never silently *open* a paywall
   or accept a billing-bearing action.
3. **No secret reaches a client bundle.** Only `NEXT_PUBLIC_*` kill-switches are
   client-exposed; provider keys, Stripe keys, and BYOK keys are server-only and
   never logged (see the never-log redaction in `orchestrator/observability.ts`).
4. **Core/render/orchestrator code must not import `@/lib/billing` or
   `@/lib/auth`.** Use `@/lib/metering` (usage/cost) and `@/lib/http` (request
   helpers). This is enforced at build time (SHE-8 boundary check).

## Canonical flag truthiness (`src/lib/env/flag.ts`)

All **server-side** boolean flags go through `isFlagEnabled(name, { defaultOn? })`.
It reads `process.env[name]` fresh on every call (no redeploy to flip):

| Value (case-insensitive, trimmed) | Result |
| --- | --- |
| `1` `true` `yes` `on` | **true** |
| `0` `false` `no` `off` | **false** |
| unset / empty / any other string | `defaultOn ?? false` |

**Server-only:** `isFlagEnabled` reads a *dynamic* key, which Next.js cannot
statically inline into a client bundle — `NEXT_PUBLIC_*` flags read in client
components must keep a literal `process.env.NEXT_PUBLIC_X` access. **Secret
presence checks** (`!!ANTHROPIC_API_KEY`, `!!STRIPE_SECRET_KEY`,
`Boolean(TURNSTILE_*)`) are NOT flags — they gate on key presence and must stay
as-is.

Two security-sensitive opt-ins (`SL_ALLOW_TIER_OVERRIDE`, `SL_BYOK_ALLOWED`)
deliberately keep the **strict** `1`/`true`-only parse rather than the wider set
above — a client-trust override should not be enabled by a loose value.

## The seams (all default-OFF, fail-closed)

| Seam | Flag (default OFF) | Gate | What it does |
| --- | --- | --- | --- |
| Accounts surface | `SL_ACCOUNTS_ENABLED` | `auth/account.ts:isAccountsEnabled` | Auth routes 404 until set (schema/recovery always live). |
| Paid generation | `SL_PAID_GENERATION` | `auth/account.ts:isPaidGenerationEnabled` | Enables the credit wallet hold/settle on a Pro generation. |
| Product/paywall tier | `SL_GENERATION_TIER` (free) | `orchestrator/generationTier.ts:resolveGenerationTier` → `toTierPolicy` injected into the orchestrator | `free` bounds generation; `pro` opens the full pipeline. Kernel reads only the injected `TierPolicy`. |
| Daily quota / abuse | `SL_DAILY_QUOTA_ENABLED` | `orchestrator/dailyQuota.ts:isDailyQuotaEnabled` | Hosted-only per-IP/device/account daily request cap. |
| BYOK key acceptance | `SL_BYOK_ALLOWED` (+ dev/test) | `orchestrator/generationTier.ts:isByokKeyAccepted` | Honors a client-supplied `debug.apiKey`/`modelOverride`; off on the hosted demo (a key-laundering vector). BYOK requests skip the credit path and use the `byokRateLimit` per-IP brake. |
| Stripe | `STRIPE_SECRET_KEY` presence | `billing/stripe.ts` | Checkout/webhooks inert without the key. |

There is **no edition primitive** (OSS vs hosted vs desktop) in the code yet; the
explicit env flags above are the de-facto signal. A first-class edition concept
is expected with the Phase-2 monorepo split.

## When you add a flag

Read it through `isFlagEnabled` (server) or a literal `NEXT_PUBLIC_*` access
(client). Give it a default; **SaaS flags default OFF**. Document it in
[`reference/env-flags.md`](reference/env-flags.md). Never let core/orchestrator
code import `@/lib/billing` or `@/lib/auth` to read a flag — put the pure read in
a neutral module (the orchestrator reads `SL_ACCOUNTS_ENABLED` via `isFlagEnabled`
directly, not via `auth/account`, precisely to keep that boundary clean).
