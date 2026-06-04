---
title: Daily Request Quota & Abuse Gating
subsystem: daily-quota
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: ab82027
source_paths:
  - src/lib/orchestrator/dailyQuota.ts
  - src/lib/security/ipRisk.ts
  - src/lib/security/ipMath.ts
  - src/lib/chat/quotaMessages.ts
  - src/lib/db/schema.ts
  - src/lib/db/janitor.ts
  - src/lib/db/maybeReap.ts
  - src/instrumentation.ts
  - src/app/api/chat/route.ts
  - src/app/api/pro-interest/route.ts
  - src/app/api/auth/signup/route.ts
  - src/lib/gdpr/exportUser.ts
  - config/ip-risk-asns.json
related:
  - env-flags
  - persistence-db
  - auth-gdpr
  - orchestrator
---

# Daily Request Quota & Abuse Gating

> **HOSTED-ONLY, OFF BY DEFAULT.** This layer exists to protect Anthropic tokens on
> the public demo at **https://sheetllm.com**. It is **disabled by default**
> (`SL_DAILY_QUOTA_ENABLED` unset) — if you self-host or run sheet-llm locally,
> leave it off and you are completely unaffected (no quota, no IP checks, no extra
> DB work). Everything below applies only when an operator explicitly turns it on.

## Why

The demo lets anonymous visitors spend real LLM tokens. The pre-existing controls —
a 5‑minute in‑memory burst limiter (`requestRateLimit.ts`) and the Turnstile bot
gate — bound *rate* and *bots* but not *daily spend*, and both reset on every
container redeploy. This layer adds a **durable daily request quota** plus an
**IP‑reputation gate**, and nudges users toward signing up / Pro.

Targets: **anonymous = 5 / 24h**, **logged‑in free = 10 / 24h**, **Pro = unlimited**
(Pro is operator‑assigned via `users.tier`; there is no checkout yet — the limit
CTA points at a `/pro` waitlist). All limits are env‑tuneable and read fresh per
request.

## Layered defense

| Layer | Purpose | Mechanism |
|---|---|---|
| L0 Cloudflare edge | Shed bots/TOR/datacenter off‑origin; inject trusted ASN + edge‑auth headers | Bot Fight Mode; WAF **Managed Challenge** (not Block) for `ip.geoip.country eq "T1"` + bad ASNs; edge rate‑limit on `/api/chat`; a Transform Rule that **SETs** `x-sl-client-asn` + `x-sl-edge-auth` |
| L1 CF‑transit assertion | Only trust `cf-*`/ASN headers when the request provably came through *our* CF zone | `isCfRequest()` — `cf-connecting-ip` + `cf-ray` (+ `SL_EDGE_AUTH_SECRET` when set) |
| L2 Burst limiter | Anti‑hammer | `checkRequestIp` (unchanged) |
| L3 Turnstile | Keep bots off the LLM surface | `hasClearance` (unchanged; fail‑open when keys unset) |
| L4 Identity + tier | anon vs logged‑in vs Pro | `getRequestUser` + `resolveGenerationTier` |
| L5 IP‑risk verdict | Classify TOR / datacenter‑VPN ASN | `assessClientRisk()` (`ipRisk.ts`) — pure, fail‑open |
| L6 Daily quota guard | The authoritative per‑request spend bound | `checkDailyQuota()` (`dailyQuota.ts`), at `/api/chat` after tier, before dispatch |
| L7 Aggregate ceiling | Bound **total** anon spend under IP/account rotation | `SL_DAILY_QUOTA_ANON_GLOBAL` + the Anthropic org spend cap |

## How it works

- **Identity keying** (`classifyQuota`): Pro → bypass (no row); verified logged‑in
  free → `u:<userId>` (10/24h); anonymous **and unverified‑logged‑in** →
  `a:<hmac(ip)>` (5/24h, so farming unverified accounts is worth no more than the
  anon path); risky **truly‑anonymous** IP → `login_required` (sign‑in CTA). An
  untrusted/`local` IP → bypass (never a shared counted bucket).
- **IP key**: `CF-Connecting-IP`, trusted only when `isCfRequest()`, normalized to
  `/24` (v4) or `/56` (v6, closes the `/64` self‑rotation multiplier; `ipMath.ts`
  also fixes the abbreviated‑IPv6 bug the shared `normalizeIp` has), then
  `HMAC(SESSION_SECRET, …)` so no raw IP is stored at rest. Off‑CF (self‑host), the
  IP comes from the hop‑aware `extractClientIp` **only when `TRUSTED_PROXY_HOPS` is
  set**; otherwise the request bypasses entirely (never a shared `local` bucket).
- **Window**: a fixed 24h window anchored at first hit, one durable `request_quota`
  row per key (`schema.ts`). One synchronous `db.transaction` evaluates the
  instance ceiling + per‑key bucket and commits both only if both pass; a
  guard‑in‑the‑write `UPDATE … WHERE count < limit` makes over‑count impossible.
- **Count‑on‑admission, never refunded.** The increment is pre‑dispatch (refunds
  would be an abuse oracle). Reset hints are coarsened to the minute (no
  to‑the‑second boundary leak).
- **Fail‑open everywhere**: any DB error → request allowed; a fail‑open admission
  cap (`SL_DAILY_QUOTA_MAX_ROWS`) bounds table bloat from distinct‑key spray
  (logged when it trips). Availability is preferred over enforcement — the
  Anthropic org spend cap is the final hard stop.
- **Retention/GDPR**: anon `a:` rows are short‑lived IP PII, reaped on a window+grace
  cutoff (`janitor.reapExpiredQuotaCounters`) both opportunistically
  (`maybeReapStaleQuota`) and at boot (`instrumentation.ts`). `u:` rows carry a
  `users` FK `ON DELETE CASCADE` (erased on account deletion + counted in the
  deletion receipt) and are included in the GDPR export (`gdpr/exportUser.ts`).
- **Limit‑reached UX** (`quotaMessages.ts` → `/api/chat` error body → client): a
  structured `cta` drives an in‑transcript card + a one‑shot modal (anon → create
  account; free → Pro waitlist; risky‑anon → sign in). The plain `error` string is
  always populated for older clients.
- **Account‑farming hardening**: `/api/auth/signup` is Turnstile‑gated, and
  unverified accounts get only the anon limit until they verify their email.

## Configuration

All flags live in `.env.example`; the canonical table is
[env-flags.md](../reference/env-flags.md#daily-request-quota--abuse-gating-hosted-only).
The master toggles are `SL_DAILY_QUOTA_ENABLED` and `SL_IP_RISK_ENABLED` (both off
by default). Limits: `SL_DAILY_QUOTA_ANON` (5), `SL_DAILY_QUOTA_FREE` (10),
`SL_DAILY_QUOTA_WINDOW_SEC` (86400), `SL_DAILY_QUOTA_ANON_GLOBAL` (off),
`SL_DAILY_QUOTA_MAX_ROWS` (200000), `SL_DAILY_QUOTA_V6_PREFIX` (56),
`SL_DAILY_QUOTA_RETENTION_GRACE_SEC` (3600). Risk: `SL_IP_RISK_TOR`, `SL_IP_RISK_ASN`,
`SL_IP_RISK_TRUSTED_ASN_HEADER`, `SL_IP_RISK_ASN_LIST_PATH`,
`SL_IP_RISK_EXTRA_DENY_ASNS`, `SL_IP_RISK_ALLOW_ASNS`, `SL_IP_RISK_ALLOW_CIDRS`,
`SL_IP_RISK_DENY_CIDRS`, `SL_IP_RISK_DEBUG`. Plus `SL_EDGE_AUTH_SECRET` and
`SL_PRO_WAITLIST_NOTIFY`.

## Operator runbook (hosted sheetllm.com)

1. **Cloudflare Transform Rule** (Rules → Transform Rules → Modify Request Header),
   using **Set** (not Add — an appended header arrives comma‑joined and
   `parseAsnHeader` rejects it as unknown):
   - `x-sl-client-asn` = `ip.geoip.asnum`
   - `x-sl-edge-auth` = `<a long random secret>`
2. **Origin** `.env` (`/opt/sheet-llm/.env`): set `SL_EDGE_AUTH_SECRET` to that same
   secret, then `SL_DAILY_QUOTA_ENABLED=1`, `SL_IP_RISK_ENABLED=1`, `SL_IP_RISK_TOR=1`,
   `SL_IP_RISK_ASN=1`, `SL_PRO_WAITLIST_NOTIFY=<email>`, and
   `SL_DAILY_QUOTA_ANON_GLOBAL=<N>`. Treat the global ceiling as **required on prod,
   not optional**: because the per‑row admission cap fails *open*, the global
   ceiling + the Anthropic org spend cap are the only controls that bound total
   anon spend under distinct‑key spray / IP rotation. Keep limits at the defaults
   or tune. Restart the container.
3. **Cloudflare WAF** (recommended, defense‑in‑depth): a Managed Challenge custom
   rule for `ip.geoip.country eq "T1"` and the datacenter ASNs, and a rate‑limit
   rule on `/api/chat`. Use **Challenge**, not Block, so the sign‑in path survives:
   the quota gate answers `login_required` with **403 + a sign‑in CTA** (a nudge,
   not a hard block; quota/ceiling limits answer **429**), and a WAF Block would
   stop a real user from ever reaching the sign‑in surface.
4. **Anthropic org spend cap**: set a monthly USD limit in the Anthropic console —
   the final hard stop that bounds total spend regardless of any in‑app bypass.

### Trust‑boundary note (important)

When `SL_EDGE_AUTH_SECRET` is **unset**, `isCfRequest()` falls back to
`cf-connecting-ip` + `cf-ray` presence — both client‑settable off‑CF — so it is
trustworthy **only** behind the hosted origin lock (origin firewalled to Cloudflare
IP ranges + Authenticated Origin Pulls/mTLS). On the hosted box that lock exists; a
non‑CF client can't complete the TLS handshake to forge those headers. Setting
`SL_EDGE_AUTH_SECRET` makes the check independent of the firewall and is strongly
recommended. Self‑hosters without that lock must leave `SL_IP_RISK_ENABLED` /
`SL_DAILY_QUOTA_ENABLED` off (the default) — committing the origin's `Caddyfile`
(CF‑IP allowlist + AOP) into the repo is a recommended follow‑up so the boundary is
reviewable.

## Threat model & residual risks

- **Account‑farming** → Turnstile on signup + unverified‑as‑anon. Residual: mass
  disposable‑email verification — bounded by L7 + the org spend cap, not per‑identity.
- **Residential/mobile‑proxy + incognito IP rotation** → cannot be stopped at the
  origin; bounded by the low anon limit + the instance ceiling + the org spend cap.
- **CGNAT / university / office NAT false positives** → shared‑egress users share one
  5/24h bucket; mitigated by the sign‑in escape hatch, low‑friction (Turnstile, not
  pre‑use verify) signup, a tuneable `SL_DAILY_QUOTA_ANON`, and the IPv6 `/56` key.
- **Header/edge forgery** → `isCfRequest()` gates all header trust; `parseAsnHeader`
  rejects multi‑valued input; off‑CF → clear (never downgrades risk).
- **Distinct‑key spray (esp. large IPv6 allocations)** → fail‑open admission cap +
  the instance ceiling; tune `SL_DAILY_QUOTA_V6_PREFIX` coarser if needed.

## Testing

`tests/unit/security/ipMath.test.ts`, `tests/unit/security/ipRisk.test.ts`,
`tests/unit/orchestrator/dailyQuota.test.ts`, `tests/unit/db/quotaReaper.test.ts`,
`tests/unit/db/quotaMigration.test.ts`, `tests/integration/api-chat-quota.test.ts`,
`tests/integration/quota-gdpr.test.ts`, `tests/unit/chat/quotaCard.test.tsx`.
