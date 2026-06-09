---
title: Environment Flags & Config Reference
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 406fcb1
source_paths:
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/generationTier.ts
  - src/lib/auth/account.ts
  - src/lib/billing/valueTier.ts
  - src/lib/billing/stripe.ts
  - src/lib/billing/checkout.ts
  - src/lib/billing/checkoutRateLimit.ts
  - src/lib/billing/scheduler.ts
  - src/lib/billing/webhookProcess.ts
  - src/lib/billing/surface.ts
  - src/lib/auth/authRateLimit.ts
  - src/lib/auth/email/index.ts
  - src/lib/auth/oauth/config.ts
  - src/lib/db/durability.ts
  - src/lib/providers/streamGuard.ts
  - src/lib/orchestrator/budget.ts
  - src/lib/orchestrator/deadline.ts
  - src/lib/orchestrator/observability.ts
  - src/lib/orchestrator/keyStatus.ts
  - src/lib/providers/select.ts
  - src/lib/providers/registry.ts
  - src/lib/providers/ollama.ts
  - src/lib/providers/degradation.ts
  - src/lib/auth/session.ts
  - src/lib/auth/recovery.ts
  - src/lib/db/index.ts
  - src/lib/debug/debugStore.ts
  - src/lib/chat/state.ts
  - src/components/editor/contextMenuFlag.ts
  - src/lib/llm/index.ts
  - src/lib/llm/client.ts
  - src/lib/shared/types.ts
  - src/instrumentation.ts
  - src/lib/orchestrator/dailyQuota.ts
  - src/lib/security/ipRisk.ts
  - playwright.config.ts
  - evals/lib/buildLiveCase.ts
  - evals/lib/pricing.ts
related:
  - orchestrator
  - providers-llm
  - auth-gdpr
  - billing
  - chat-session
  - evals-testing
---

# Environment Flags & Config Reference

The complete inventory of `process.env` reads across `src/`, `evals/`, and the
test config, grouped by subsystem. Every entry below was verified by opening
the file that reads it at commit `4359406`. Each row gives the **default** (the
value the code falls back to when the var is unset), the **type** of the value
the code expects, and the **read site** (the file + symbol that consumes it).

## Conventions used by the readers

The flag readers are deliberately inconsistent in how they parse truthiness —
match the exact predicate when scripting a deploy.

| Reader pattern | Truthy when | Falsy/default when | Where |
| --- | --- | --- | --- |
| `readBool(name)` | `'1'` or `'true'` (case-insensitive) | anything else, incl. unset | `src/lib/orchestrator/flags.ts:1` |
| `readExplicitFalse(name)` | n/a (returns *true* only for `'0'`/`'false'`) | unset → not-explicit-false → **feature ON** | `src/lib/orchestrator/flags.ts:7` |
| `=== '1'` exact | `'1'` only | everything else | session/eval flags |
| `!== '1'` exact | everything except `'1'` | `'1'` | `SL_INSECURE_COOKIE_OK` (note: inverted) |
| `!== 'off'` exact | everything except `'off'` | `'off'` | `NEXT_PUBLIC_BALANCED_EDITS` |

> **Footgun:** the orchestrator feature flags (`SL_NEW_TOOL_DISPATCH`,
> `SL_REPLACEMENT_GATE`, `SL_GHOST_PREVIEW`, `SL_SECTIONAL_GEN`) use `readExplicitFalse`, which means
> **only the literal strings `0` or `false` turn them off**. `SL_GHOST_PREVIEW=no`
> or `=disabled` leaves the feature ON. See `src/lib/orchestrator/flags.ts:7`.

All orchestrator flags are **read on every request** (no module-load caching),
so a host-level env flip takes effect on the next `/api/chat` call without a
redeploy. The provider/budget caps are likewise re-read per call. The auth
key-id and DB path are resolved at module load.

---

## Orchestrator

Read in `src/lib/orchestrator/flags.ts`, `budget.ts`, `deadline.ts`,
`observability.ts`. The canonical deep reference is
[`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md); the
table below reproduces its flag table and adds the budget/deadline/log vars,
each **verified against `flags.ts` at this commit**.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `ORCHESTRATOR_KILL` | unset (off) | bool (`1`/`true`) | Operator kill switch. When truthy, `getOrchestratorMode()` returns `'off'` and the route falls through to the legacy LLM. Highest precedence. `flags.ts:31` |
| `ORCHESTRATOR_ENABLED` | unset (enabled) | explicit-false (`false`/`0`) | Route-level opt-out. Only the literal `false`/`0` disables; any other value (incl. unset) leaves it enabled. `flags.ts:32` |
| `ORCHESTRATOR_MODE` | unset → `primary` | enum: `shadow` | Set `shadow` to run the orchestrator alongside legacy (legacy wins the response, divergence logged). Any other value resolves to `primary`. `flags.ts:33` |
| `SL_NEW_TOOL_DISPATCH` | **on** | explicit-false | Native 5-tool dispatcher. `0`/`false` rolls back to the legacy Haiku classifier path. `flags.ts:78` |
| `SL_REPLACEMENT_GATE` | **on** | explicit-false | Replacement-as-confirmation gate. `0`/`false` disables the gate (turns are never marked `requiresConfirmation`). `flags.ts:91` |
| `SL_GHOST_PREVIEW` | **on** | explicit-false | AI ghost preview (M24). `0`/`false` reverts to silent-commit; overlay/panel UI never fires. `flags.ts:113` |
| `SL_SECTIONAL_GEN` | **on** | explicit-false | Sectional streamed score generation (M25). Routes fresh `generate_complex` requests (no `editedScore`) through the plan→seed→extend pipeline, delivering sections via SSE. `0`/`false` falls back to single-shot `runGenerateComplex`. `flags.ts:128` |
| `SL_COMPOSE_PATCH_DISPATCH` | off | bool | **Deprecated** (Lever B compose sub-classifier). Dead code when `SL_NEW_TOOL_DISPATCH` is on; only honored on the legacy path. `flags.ts:62` |
| `SL_GENERATION_TIER` | unset → `free` | enum: `pro` | **M26** product/paywall tier (orthogonal to the model-size tier). `free` (default) routes a fresh from-scratch generation to the bounded ≤4-bar single-call handler (`max_tokens` = 2600 kill-switch, no planner/sectional loop); `pro` keeps the sectional/whole-score pipeline. Per-request resolution order (`generationTier.ts:resolveGenerationTier`): `SL_FORCE_FREE_TIER` kill switch → debug-panel `generationTier` override (**dev/test only, or `SL_ALLOW_TIER_OVERRIDE`; ignored in production** — see [Debug panel](#debug-panel)) → instance `SL_GENERATION_TIER=pro` opens pro for everyone → per-user entitlement upgrade behind `SL_ENTITLEMENTS_DB` (a `pro` tier + verified email → pro; see [Accounts](#accounts-signup--login--oauth--settings--paywall--durability)) → this env default. On the **edit/refine** path `free` also enforces the policy: `regenerate_all` (whole-score rewrite) → Pro-only refusal (`refused`, code `pro_only`), and `extend_composition` / `insert_measures` growth is clamped to the bar budget (`free` = 4, with a user warning); `pro` (64) leaves them untouched. On a **fall-through**, `free` does NOT run the legacy single-shot regen at all (it's slow even token-capped, and emits invalid scores for refinements) — the route returns a clean `refused` 422 and the dispatcher reroutes botched tool-args to `edit_intra_measure` (ops, not a regen) to keep the turn bounded; only `mode=off`+`free` still uses the legacy path, capped to `max_tokens` 2600 / 1 retry. `pro` keeps the full legacy safety net. **SHE-8:** resolution order is unchanged, but the orchestrator no longer imports `policyFor` — `route.ts` maps the resolved tier to an injected `TierPolicy` (`generationTier.ts:toTierPolicy`) that the kernel reads for all four gates. An absent policy is uncapped (the OSS/headless default), so the hosted paywall is enforced by the route always injecting the capped policy, not by a kernel default. `generationTier.ts:getGenerationTier`, `generationTier.ts:toTierPolicy`, `orchestrator/index.ts:runDispatchedHandler`, `orchestrator/toolDispatch.ts`, `api/chat/route.ts` |
| `SL_FORCE_FREE_TIER` | unset (off) | bool (`1`/`true`) | **M26** operator kill — forces `free` for the instance regardless of `SL_GENERATION_TIER` or per-user entitlement, instantly stopping long-running pro generation. `generationTier.ts:isForceFreeTier` |
| `SL_ALLOW_TIER_OVERRIDE` | unset (off) | bool (`1`/`true`) | **PR-0** opt-in that lets the **client-supplied** debug `generationTier` override take effect when `NODE_ENV=production` (e.g. a staging build). **DANGEROUS on anything internet-reachable** — it lets callers self-select the `pro` tier and bypass the paywall. Leave unset in prod; the override is auto-honored only when `NODE_ENV` is `development`/`test`. `generationTier.ts:isTierOverrideAllowed` |
| `SL_BYOK_ALLOWED` | unset (off) | bool (`1`/`true`) | **SHE-8** opt-in that lets the **client-supplied** `debug.apiKey` (BYOK, plumbed as `apiKeyOverride`) and `debug.modelOverride` be honored when `NODE_ENV=production`. **Fail-closed: leave unset on the shared hosted demo** — honoring a client key unconditionally is a key-laundering / billing-evasion primitive. Enable ONLY on a single-tenant self-hosted/desktop instance (the OSS/desktop signal until an edition primitive exists). Auto-honored when `NODE_ENV` is `development`/`test`. A BYOK request is forced OFF the credit money path (no `placeHold`/settle) and onto a separate per-IP limiter. `generationTier.ts:isByokKeyAccepted`, `api/chat/route.ts` |
| `SL_BYOK_IP_RATE_LIMIT` | unset → `30` | int (>0) | **SHE-8** per-IP request cap (5-min sliding window) for accepted BYOK requests, SEPARATE from `SL_REQUEST_IP_RATE_LIMIT` (BYOK is off our token-spend path but still hits shared infra). Only applies when a BYOK key is accepted; a single-tenant self-host can raise it. `orchestrator/byokRateLimit.ts:checkByokIp` |
| `SL_BOUNDED_GEN` | **on** | explicit-false | **M26** free-tier bounded handler. `0`/`false` reverts free users to the legacy/sectional path WITHOUT opening the paywall (independent rollback of the new code path). `flags.ts:isBoundedGenEnabled` |
| `SL_STREAM_ABORT` | off | bool | **M26** opt-in secondary streaming kill-switch (output-token + wall-clock abort wired into `textStream` via `providers/streamGuard.ts`). Off by default — the bounded `render_score` path is non-streaming and bounded by `max_tokens` alone. `flags.ts:isStreamAbortEnabled` |
| `ORCHESTRATOR_BUDGET_INPUT_TOKENS` | `200000` | positive int | Per-session input-token cap; usage `>=` cap blocks further turns. Non-finite / `<=0` falls back to default. `budget.ts:20` |
| `ORCHESTRATOR_BUDGET_OUTPUT_TOKENS` | `50000` | positive int | Per-session output-token cap. Same fallback rule. `budget.ts:21` |
| `DEADLINE_MS` | `55000` | positive int | Per-request soft deadline; handlers consult `remainingMs` and emit `deadline_exceeded` rather than overrun Vercel's 60s `maxDuration`. `deadline.ts:15` |
| `ORCHESTRATOR_LOG_SILENT` | unset (logs on) | exact `1` | When `'1'`, suppresses the structured per-turn `orchestrator.turn` stdout log and handler debug logs. Set by `tests/setup.ts`. `observability.ts:94`, plus handler logs in `handlers/*.ts` |

**Invariants / gotchas:**
- Precedence is strict: `ORCHESTRATOR_KILL` > `ORCHESTRATOR_ENABLED=false` >
  `ORCHESTRATOR_MODE=shadow` > `primary` (`flags.ts:30`).
- `SL_GHOST_PREVIEW` and `SL_REPLACEMENT_GATE` are mutually exclusive on a single
  turn — when both apply, the **replacement gate wins** (it owns the modal +
  "don't ask again" affordance). See `flags.ts:107`.
- The budget cap is memoized in a module-level `cap` after first read
  (`budget.ts:18`); `_setBudgetCap`/`_resetBudget` are test-only overrides.

See also: [`docs/subsystems/orchestrator.md`](../subsystems/orchestrator.md),
[`docs/subsystems/ghost-preview.md`](../subsystems/ghost-preview.md).

---

## Providers (multi-provider LLM routing)

Read in `src/lib/providers/select.ts`, `registry.ts`, `ollama.ts`,
`keyStatus.ts`. Tier-to-provider routing reads one var per tier; provider
keys gate `isProviderConfigured`.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `PROVIDER_SMALL` | `anthropic` | enum: `anthropic`\|`groq`\|`ollama` | Provider for the `small` tier (Haiku-class). Invalid values fall back to `anthropic`. `select.ts:9`, `:21` |
| `PROVIDER_MEDIUM` | `anthropic` | enum (same) | Provider for the `medium` tier (Sonnet-class). `select.ts:9` |
| `PROVIDER_LARGE` | `anthropic` | enum (same) | Provider for the `large` tier (Opus-class). `select.ts:9` |
| `PROVIDER_FALLBACK` | `anthropic` | enum (same) | Provider chosen when the tier provider is unconfigured or degraded. `select.ts:27`, also `keyStatus.ts:30` |
| `ANTHROPIC_API_KEY` | unset | string | Gates `isProviderConfigured('anthropic')`. Without it, the Anthropic provider is "unconfigured" and selection falls back. `registry.ts:78`, `:86` |
| `GROQ_API_KEY` | unset | string | Gates `isProviderConfigured('groq')`. `registry.ts:79` |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | URL string | Base URL for the local Ollama OpenAI-compat endpoint. Ollama is keyless — `isProviderConfigured('ollama')` is always `true`. `ollama.ts:27`, `registry.ts:84` |

**Selection order** (`select.ts:76`): sticky-per-chat → `PROVIDER_<TIER>` →
degradation auto-failover to `PROVIDER_FALLBACK` (after
`DEGRADATION_THRESHOLD = 2` schema failures on the chat+tier, see
`degradation.ts:13`) → unconfigured fallback to `PROVIDER_FALLBACK` →
`anthropic` built-in. The registered model ids (e.g. small→`claude-haiku-4-5`,
medium→`claude-sonnet-4-6`, large→`claude-opus-4-7`) live in `registry.ts:28`
and are **not** env-overridable in production (only the debug `modelOverride`
path, below).

See also: [`docs/subsystems/providers-llm.md`](../subsystems/providers-llm.md).

### Legacy single-Anthropic client

The legacy `render_score` path (`src/lib/llm/`) is a separate, pre-provider
client still reached on the legacy fall-through.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | string | `getLLMClient()` returns the real Anthropic client when set, else the in-memory `stubClient` (keyless dev / stub mode). `llm/index.ts:17` |
| `ANTHROPIC_API_KEY` | unset | string | `realClient` throws `UpstreamError('ANTHROPIC_API_KEY is not set', 500)` if invoked without it. `llm/client.ts:15` |

The chat route also reads `ANTHROPIC_API_KEY` directly to report `real`-vs-`stub`
legacy-client status in the debug payload (`src/app/api/chat/route.ts:590`,
`:744`, `:825`). A per-request `apiKey` override exists for the debug panel only
(`ChatDebugOverrides.apiKey`, `src/lib/shared/types.ts:37`), which the
provider/anthropic client honors via a one-shot SDK client
(`src/lib/providers/anthropic.ts:36`) — it never touches `process.env`.

---

## Auth & GDPR

Read in `src/lib/auth/session.ts` and `src/lib/auth/recovery.ts`. The two
secrets are **required** — the getter throws at first use if missing — and must
be **distinct** so they can be rotated independently.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `SESSION_SECRET` | **required** (throws) | string ≥32 bytes | HS256 signing key for the `sl_uid` session JWT. `getSecret()` throws if unset or `<32` bytes (RFC 7518 §3.2). `session.ts:25` |
| `RECOVERY_SECRET` | **required** (throws) | string ≥32 bytes | Separate HS256 key for the localStorage recovery-token backup. Must differ from `SESSION_SECRET`. `recovery.ts:34` |
| `SESSION_KEY_KID` | `s1` | string | `kid` header on session JWTs for future key rotation. `session.ts:15` |
| `RECOVERY_KEY_KID` | `r1` | string | `kid` header on recovery tokens. `recovery.ts:30` |
| `SL_INSECURE_COOKIE_OK` | unset (Secure ON) | exact `1` (inverted) | When `'1'`, the session cookie is set **without** `Secure`, so plain-HTTP localhost/e2e works. Any other value (incl. unset) keeps `Secure`. `session.ts:65` |

**Gotcha:** the `Secure` predicate is `process.env.SL_INSECURE_COOKIE_OK !== '1'`
— it is the *only* flag in the repo whose absence means the *strict* behavior and
whose presence (exactly `'1'`) means *relaxed*. Never set it in production.

See also: [`docs/subsystems/auth-gdpr.md`](../subsystems/auth-gdpr.md).

---

## Accounts (signup / login / OAuth / settings / paywall / durability)

The accounts feature is **dark by default** — every `/api/auth/*` route 404s
until an operator sets `SL_ACCOUNTS_ENABLED` (the schema, recovery/claim gate, and
identity resolver are always live; only the user-facing surface is gated). The
production flip is the LAST launch step — see **Launching accounts** below.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `SL_ACCOUNTS_ENABLED` | unset (**off** → 404) | bool (`1`/`true`) | Master switch for the signup/login/logout/OAuth/settings surface. `account.ts:isAccountsEnabled` |
| `TRUSTED_PROXY_HOPS` | unset (leftmost XFF) | int | Pins the real client IP for auth rate-limiting to the Nth `x-forwarded-for` from the right. Set to `1` behind a single edge/CDN; unset → spoofable leftmost; fails **closed** if set higher than the actual depth. `authRateLimit.ts:extractClientIp` |
| `RESEND_API_KEY` + `EMAIL_FROM` | unset (console provider) | string | Set BOTH to send verification/reset email via Resend; else the console provider logs to the terminal in dev and **withholds the body in prod**. `email/index.ts:getEmailProvider` |
| `APP_BASE_URL` | request origin | URL | Base for links in outbound email; set behind a proxy whose Origin differs. `email/index.ts:resolveAppBaseUrl` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | unset (provider off) | string | Google OAuth — button + routes 404 unless BOTH are set. `oauth/config.ts:isOAuthConfigured` |
| `GITHUB_CLIENT_ID` / `_SECRET` | unset (provider off) | string | GitHub OAuth (uses `/user/emails` primary+verified only). `oauth/config.ts` |
| `OAUTH_REDIRECT_BASE_URL` | request origin | URL | Base for the OAuth callback URL registered with the providers. `oauth/config.ts:oauthRedirectUri` |
| `SL_ENTITLEMENTS_DB` | unset (instance-wide tier) | bool (`1`/`true`) | Activates the per-user paywall: `resolveGenerationTier` upgrades a request to `pro` when `users.tier='pro'` **and** `email_verified=1`. Upgrade-only (never downgrades below `SL_GENERATION_TIER`). `generationTier.ts:isEntitlementsDbEnabled` |
| `SL_REQUIRE_WAL` | unset (warn) | exact `1` | Durability gate: a non-WAL journal becomes a **FATAL boot error** (refuses to start unreplicated). Set with Litestream live BEFORE the accounts flip. `durability.ts:isReplicationConfigured` |
| `LITESTREAM_REPLICA_URL` (+ `LITESTREAM_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`) | unset | URL + creds | Object-storage replica destination; also flips the WAL gate on. `litestream.yml`, `durability.ts` |

### Launching accounts

Accounts ship **default-off in code on purpose** — flipping the code default
would enable the surface in dev/preview/test *without* the durability gate. Enable
per environment, in order:

1. Run the **[durability launch gate](../guides/durability-runbook.md)**: Litestream
   live, `SL_REQUIRE_WAL=1`, restore drill verified, non-ephemeral snapshotted volume.
2. Set `SESSION_SECRET` + `RECOVERY_SECRET` (distinct), `TRUSTED_PROXY_HOPS`,
   `RESEND_API_KEY` + `EMAIL_FROM`, and any OAuth credentials.
3. Set **`SL_ACCOUNTS_ENABLED=1`** and redeploy — the routes go live on the next
   request (the flag is read fresh, no further deploy needed to toggle).
4. (Optional paywall) Set `SL_ENTITLEMENTS_DB=1` once a billing path writes
   `users.tier='pro'`.

See also: [`auth-data-lifecycle.md`](../subsystems/auth-data-lifecycle.md) (retention
+ breach rotation), [`durability-runbook.md`](../guides/durability-runbook.md).

---

## Billing & paywall (prepaid credits)

**HOSTED sheetllm.com ONLY; OFF BY DEFAULT** — the whole credit paywall + Stripe
money path is dark unless an operator opts in. A self-hosted install never touches
Stripe (open-source self-host IS the BYOK path: bring your own `ANTHROPIC_API_KEY`,
generate for free, no credits). Every billing route 404s without `STRIPE_SECRET_KEY`,
and `/api/chat` never holds/charges credits without `SL_PAID_GENERATION`. Read fresh
per request (the janitor interval is read at boot). Full design:
[`billing.md`](../subsystems/billing.md).

### Paid generation (the credit paywall on `/api/chat`)

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `SL_PAID_GENERATION` | unset (**off**) | bool (`1`/`true`) | Master switch for the credit paywall. Off → `/api/chat` never holds or debits; the wallet engine is inert. On → an authenticated **Pro** request places a worst-case hold pre-dispatch (fail-CLOSED) and settles to the cost-plus charge. `account.ts:isPaidGenerationEnabled` |
| `SL_MAX_GEN_HOLD_CREDITS` | `1500` | positive int | Cap (credits; 1cr = 1¢) on the pre-dispatch hold = the most a single sectional generation can spend before the pump aborts at budget. `valueTier.ts:maxGenerationHoldCredits` |
| `SL_FREE_PIECE_BUDGET_CREDITS` | `250` | positive int | Per-run cost ceiling for the one-time free full piece (it has no hold, so this bounds its spend). `valueTier.ts:freePieceBudgetCredits` |
| `SL_ADVANCED_COMPOSER` | unset (off) | bool (`1`/`true`) | Enables the **Advanced Composer** (Opus) Pro toggle — a paid Pro turn may route its heavy compositional call to Opus (self-funding via the higher metered cost; no premium markup). Honored only for a paid Pro generation (never free / free-piece). `generationTier.ts:isAdvancedComposerEnabled` |

### Stripe (money-in)

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | unset | string | Gates `isStripeEnabled()` — without it every `/api/billing/*` route 404s and `getStripe()` throws. `stripe.ts:isStripeEnabled` |
| `STRIPE_WEBHOOK_SECRET` | unset | string | Signing secret for `POST /api/billing/webhook`; the endpoint is dark (404) unless BOTH this and `STRIPE_SECRET_KEY` are set. `webhook/route.ts:isWebhookConfigured` |
| `SL_STRIPE_TAX_CODE` | `txcd_10000000` | string | Stripe Tax product tax code (digital goods) set explicitly on each Checkout line item so `automatic_tax` computes. `checkout.ts:DEFAULT_STRIPE_TAX_CODE` |

### Checkout rate limit (per-user + per-IP throttle on session creation)

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `SL_CHECKOUT_USER_RATE_LIMIT` | `10` | positive int | Checkout-session creations / hour / claimed user. `checkoutRateLimit.ts` |
| `SL_CHECKOUT_IP_RATE_LIMIT` | `20` | positive int | Checkout-session creations / hour / client IP (catches one host spraying accounts). `checkoutRateLimit.ts` |
| `SL_CHECKOUT_RATE_MAX_ENTRIES` | `50000` | positive int | In-memory store-size cap; fail-CLOSED for a new key once reached (anti-OOM). `checkoutRateLimit.ts` |

### Billing janitor scheduler (PR-13, in-process)

The deployment is a single long-lived container, so the money-critical janitors
run on an in-process boot-sweep + interval started from `instrumentation.ts` (no
external cron). The timer only starts if a billing subsystem is enabled.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `SL_BILLING_JANITOR_INTERVAL_MS` | `300000` (5 min) | positive int | Period of the in-process billing janitor: reaps expired credit holds, **reconciles** Stripe webhook grants stuck at `received`/`failed` (the only auto-heal for a paid-but-not-granted purchase — a transient webhook failure still returns 200, so Stripe won't retry), prunes aged `stripe_events`, evicts cold checkout-rate keys. `scheduler.ts:startBillingScheduler` |
| `SL_STRIPE_EVENT_RETENTION_DAYS` | `90` | positive int | Retention window for terminal-good (`processed`/`ignored`) `stripe_events` inbox rows before the janitor prunes their raw payloads. `webhookProcess.ts:pruneStripeEvents` |

**Gating summary:** the customer wallet UI (`/settings` → Credits) shows iff
`isBillingSurfaceEnabled()` = `isStripeEnabled() || isPaidGenerationEnabled()`
(`surface.ts`) — a self-host with neither sees nothing. The paywall (credit
hold/charge) is gated on `SL_PAID_GENERATION`; the buy flow on `STRIPE_SECRET_KEY`.
**Do NOT flip `SL_PAID_GENERATION` until the launch gates land** (Stripe
account/keys/Tax/Radar, attorney memo, Anthropic ToS) — see
[`billing.md`](../subsystems/billing.md#launch--operator-checklist).

See also: [`docs/subsystems/billing.md`](../subsystems/billing.md).

---

## Persistence (DB)

Read in `src/lib/db/index.ts` and `src/instrumentation.ts`.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `DATABASE_URL` | `file:./data/sheet-llm.db` | `file:*` URL | SQLite file path. Only `file:` URLs are supported; anything else throws. Accepts `file:path`, `file:/path`, `file:///abs`, and `:memory:`. `db/index.ts:18` |
| `NEXT_RUNTIME` | set by Next.js | `'nodejs'` gate | `register()` runs Drizzle migrations + the stale-partial janitor only when `=== 'nodejs'` (skips edge runtime). `instrumentation.ts:6` |

`drizzle.config.ts:3` also reads `DATABASE_URL` for the migration-generation CLI.

See also: [`docs/subsystems/persistence-db.md`](../subsystems/persistence-db.md).

---

## Chat session (client store)

Read in `src/lib/chat/state.ts`. These run in the browser bundle, so only
`NEXT_PUBLIC_*` vars and build-time `NODE_ENV` are visible.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_BALANCED_EDITS` | unset (balanced ON) | exact `off` | Kill switch for the balanced-edit op path (drag/duration changes). When `=== 'off'`, the balanced-edit action silently no-ops. Any other value enables it. `state.ts:1192` |
| `NEXT_PUBLIC_SL_CONTEXT_MENU` | unset (menu ON) | exact `off` | **M27** kill switch for the right-click context menu. When `=== 'off'`, `isContextMenuEnabled()` is false so `useScoreContextMenu` never intercepts `contextmenu` (the native browser menu shows). Any other value (incl. unset) enables it. `src/components/editor/contextMenuFlag.ts` |
| `NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD` | unset (clipboard ON) | exact `off` | **M28** kill switch for the context-menu Cut/Copy/Paste rows. When `=== 'off'`, `isClipboardEnabled()` is false so the clipboard section is hidden. Any other value (incl. unset) enables it. `src/components/editor/contextMenuFlag.ts` |
| `NEXT_PUBLIC_SL_CONTEXT_AI` | unset (AI rows ON) | exact `off` | **M29** kill switch for the context-menu AI rows (Edit-with-AI / Regenerate / Explain). When `=== 'off'`, `isAiEntryEnabled()` is false so the AI section is hidden. The rows are **seed-only** — they pre-fill a 1-based scoped prompt into the chat input (`seedAiInput`); the user sends, and the request flows through the normal `/api/chat` pipeline. `src/components/editor/contextMenuFlag.ts` |
| `NODE_ENV` | build-provided | `production` gate | Outside production, a dev-only `validateScore` assertion runs after balanced ops to surface invalid scores. `state.ts:1245`, `:1306` |

`SL_GHOST_PREVIEW` (server-side, above) also governs whether this store ever
receives a `PendingProposal` to render.

See also: [`docs/subsystems/chat-session.md`](../subsystems/chat-session.md).

---

## Debug panel

Read in `src/lib/debug/debugStore.ts`.

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `NODE_ENV` | build-provided | `development` gate | The debug panel is auto-enabled when `=== 'development'`. `debugStore.ts:81` |
| `NEXT_PUBLIC_DEBUG_PANEL` | unset (off in prod) | `true`\|`1` | Force-enables the debug panel outside dev. `debugStore.ts:82` |

Beyond the enable gates above, the panel ships **per-request overrides** (not
env vars) in the POST body's `debug` field via `buildDebugOverrides`
(`debugStore.ts`), validated server-side by `DebugOverridesSchema`
(`app/api/chat/route.ts`): `orchestrator` (mode), `modelOverride`, `apiKey`,
and **`generationTier`** — the **Paywall mode** toggle. `auto` sends nothing
(server resolves the tier); `free` forces the bounded ≤4-bar path (paywall ON);
`pro` forces full generation (paywall OFF). Because it is a **client-supplied**
field, honoring it in production would be a paywall bypass, so unlike
`modelOverride`/`apiKey` it is **gated**: `resolveGenerationTier` honors it only
when `NODE_ENV` is `development`/`test` or the operator sets `SL_ALLOW_TIER_OVERRIDE`
(`generationTier.ts:isTierOverrideAllowed`) — in a normal production deployment it
is **ignored**. It also still sits **below** the operator `SL_FORCE_FREE_TIER`
kill switch. The resolved tier is echoed back as `debug.generationTier` in the
response and shown in the panel's "Last response" readout.

---

## Evals & test harness

Read in `evals/lib/*` and test config. None affect production runtime;
they gate which eval tiers run and how loud the output is. The live evals are
**off unless all gates pass** (`evals/lib/buildLiveCase.ts:78`).

| Flag | Default | Type | Effect / read site |
| --- | --- | --- | --- |
| `RUN_LIVE_EVALS` | unset (skip) | exact `1` | Master gate for live (real-API) eval cases; without it they skip with `no_run_flag`. `buildLiveCase.ts:79` |
| `RUN_LIVE_FULL` | unset (skip expensive) | exact `1` | Also run cases marked `expensive`. `buildLiveCase.ts:81` |
| `RUN_SMOKE_EVALS` | unset (skip) | exact `1` | Gate for the smoke-tier dispatch eval cases. `evals/cases/smoke/*.smoke.eval.ts` |
| `ANTHROPIC_API_KEY` | unset | string | Required for any live/smoke eval; absence skips with `no_api_key`. `buildLiveCase.ts:80` |
| `SL_NEW_TOOL_DISPATCH` | (forced `1` in live setup) | bool | Live eval `beforeAll` pins the new dispatcher on, restoring the prior value after. `buildLiveCase.ts:123` |
| `EVAL_SILENT` | unset (verbose) | exact `1` | Suppress per-row / summary eval log lines. `buildLiveCase.ts:225`, `pricing.ts:47`, `liveRunner.ts`, `baselines.ts:60` |
| `EVAL_SUMMARY_ONLY` | unset | exact `1` | Suppress per-row lines but keep summary. `buildLiveCase.ts:226` |
| `EVAL_DEBUG_SKIP` | unset | exact `1` | Emit a `[eval skip]` line explaining why a case skipped. `buildLiveCase.ts:235` |
| `LIVE_EXIT_CODE` | (runner-set) | int | Carries the live-eval exit status out of the live runner. |

**Test-time env (set by harness, not operators):** `tests/setup.ts` sets
`ORCHESTRATOR_ENABLED='false'` and `ORCHESTRATOR_LOG_SILENT='1'`.
`playwright.config.ts` injects into the dev `webServer`:
`SESSION_SECRET` (default `e2e-test-session-secret-not-for-production-use-32b+`,
`playwright.config.ts:16`) and `SL_INSECURE_COOKIE_OK='1'`
(`playwright.config.ts:41`), and reads the `CI` env var to set
`forbidOnly`/`retries`/`reporter`/`reuseExistingServer`
(`playwright.config.ts:21`).

See also: [`evals/README.md`](../../evals/README.md),
[`docs/subsystems/evals-testing.md`](../subsystems/evals-testing.md).

---

## Quick-reference: production-relevant defaults

Minimum env to boot a working production instance:

```
SESSION_SECRET=<>=32 random bytes>        # required, throws if missing
RECOVERY_SECRET=<>=32 random bytes>       # required, MUST differ from SESSION_SECRET
ANTHROPIC_API_KEY=<key>                   # else LLM falls to stub; providers unconfigured
DATABASE_URL=file:./data/sheet-llm.db     # default; only file:* supported
# everything else is safe to leave unset:
#   orchestrator + ghost preview + replacement gate + tool dispatch + sectional gen all default ON
#   Secure cookies default ON (do NOT set SL_INSECURE_COOKIE_OK in prod)
```

---

## See also

- `src/lib/orchestrator/flags.ts` — the authoritative flag readers
- `src/lib/orchestrator/README.md` — orchestrator flag table + rollback runbook
- `src/lib/providers/select.ts`, `src/lib/providers/registry.ts` — provider routing + key gating
- `src/lib/auth/session.ts`, `src/lib/auth/recovery.ts` — required secrets
- `src/lib/db/index.ts` — `DATABASE_URL` parsing
- [`docs/subsystems/orchestrator.md`](../subsystems/orchestrator.md),
  [`docs/subsystems/providers-llm.md`](../subsystems/providers-llm.md),
  [`docs/subsystems/auth-gdpr.md`](../subsystems/auth-gdpr.md)

## Daily request quota & abuse gating (hosted-only)

**HOSTED sheetllm.com ONLY; OFF BY DEFAULT** — inert unless `SL_DAILY_QUOTA_ENABLED`
is set, so self-hosted/local installs are unaffected. All read fresh per request.
Full design + Cloudflare runbook: [`daily-quota.md`](../subsystems/daily-quota.md).
Readers: `src/lib/orchestrator/dailyQuota.ts`, `src/lib/security/ipRisk.ts`.

| Var | Default | Meaning |
| --- | --- | --- |
| `SL_DAILY_QUOTA_ENABLED` | off | Master toggle for the daily quota on `/api/chat`. |
| `SL_DAILY_QUOTA_ANON` | `5` | Anonymous requests / 24h, keyed on the pseudonymized CF-Connecting-IP. |
| `SL_DAILY_QUOTA_FREE` | `10` | Verified logged-in (non-Pro) requests / 24h, keyed on userId. Unverified → the anon bucket. |
| `SL_DAILY_QUOTA_WINDOW_SEC` | `86400` | Window length (seconds). |
| `SL_DAILY_QUOTA_ANON_GLOBAL` | off | Optional instance-wide anon ceiling / window — aggregate backstop vs IP/account rotation. |
| `SL_DAILY_QUOTA_MAX_ROWS` | `200000` | Fail-OPEN row cap (bounds table bloat; new keys past it are admitted without a row). |
| `SL_DAILY_QUOTA_V6_PREFIX` | `56` | IPv6 prefix the anon key collapses to. |
| `SL_DAILY_QUOTA_RETENTION_GRACE_SEC` | `3600` | Grace after a window closes before the anon IP row is reaped. |
| `SL_IP_RISK_ENABLED` | off | Master toggle for the IP-reputation verdict. |
| `SL_IP_RISK_TOR` | off | Treat `cf-ipcountry=T1` (Cloudflare's free TOR signal) as risky. |
| `SL_IP_RISK_ASN` | off | Treat a denylisted client ASN as risky (needs the CF Transform Rule). |
| `SL_IP_RISK_TRUSTED_ASN_HEADER` | `x-sl-client-asn` | Header the CF rule SETs to `ip.geoip.asnum` (trusted only on a CF request). |
| `SL_IP_RISK_ASN_LIST_PATH` | `config/ip-risk-asns.json` | Datacenter/VPN ASN denylist file (mtime hot-reloaded). |
| `SL_IP_RISK_EXTRA_DENY_ASNS` / `SL_IP_RISK_ALLOW_ASNS` | — | CSV deny-merge / allow-override (allow beats deny). |
| `SL_IP_RISK_ALLOW_CIDRS` / `SL_IP_RISK_DENY_CIDRS` | — | CSV CIDR allow / deny (allow wins). |
| `SL_IP_RISK_DEBUG` | off | Log per-request risk verdicts (hashed IP only). |
| `SL_EDGE_AUTH_SECRET` | unset | Shared secret a CF Transform Rule SETs as `x-sl-edge-auth`; makes `isCfRequest()` independent of the CF-IP firewall. |
| `SL_PRO_WAITLIST_NOTIFY` | unset | Operator email for `/api/pro-interest` (else `/pro` uses a `mailto:` fallback). |

## Legal pages (Terms of Service & Privacy Policy)

The public `/terms` and `/privacy` pages (and their UI links on the signup and
settings footers) are **gated on three REQUIRED operator-identity values**. If
any is unset/blank, both pages `notFound()` (404) and the links are hidden — we
never surface a legal document that still reads "[LEGAL ENTITY]". The values are
substituted into the page text at render time (`renderLegalDoc` in
`src/lib/legal/config.ts`). Read at RUNTIME (the pages are `force-dynamic`), so a
`.env` change takes effect on the next request after the container reloads — no
image rebuild. The documents still contain other bracketed `[PLACEHOLDERS]`
(contact mailboxes, retention periods, transfer mechanisms, …) that need legal
review before launch.

| Flag | Default | Effect / read site |
| --- | --- | --- |
| `SL_LEGAL_ENTITY` | unset | Operator's registered legal name (GDPR controller), e.g. `Jane Doe` or `Acme GmbH`. `legal/config.ts:getLegalConfig` |
| `SL_LEGAL_ADDRESS` | unset | Operator's business/registered address (Stripe requires this; EU may require an Impressum). `legal/config.ts:getLegalConfig` |
| `SL_LEGAL_JURISDICTION` | unset | Governing law / forum, e.g. `Germany`; also used for the tax-records retention reference. `legal/config.ts:getLegalConfig` |

**Gating summary:** all three must be non-empty → `isLegalEnabled()` true → pages
render + links show; otherwise 404 + no links.
