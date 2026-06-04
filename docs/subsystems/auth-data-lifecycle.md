---
title: Auth Data Lifecycle — Retention, GC & Breach Response
subsystem: auth
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: e6f5a58
source_paths:
  - src/lib/db/janitor.ts
  - src/lib/db/maybeReap.ts
  - src/lib/auth/sessionStore.ts
  - src/lib/auth/authTokens.ts
  - src/lib/auth/recovery.ts
  - src/lib/gdpr/exportUser.ts
---

# Auth Data Lifecycle

How the account tables are retained, garbage-collected, and what to rotate when
something leaks. Companion to [auth-gdpr.md](./auth-gdpr.md) (export/delete) and
the [env-flags reference](../reference/env-flags.md) (secrets).

## Retention & garbage collection

Dead auth rows are kept for a short audit window, then **hard-deleted** by the
opportunistic janitor. Reapers live in `src/lib/db/janitor.ts` (sync,
better-sqlite3); they are scheduled via a throttled microtask in
`src/lib/db/maybeReap.ts` so the triggering request never pays the write-lock
latency.

| Table | Kept while… | GC'd when | Retention | Reaper |
|---|---|---|---|---|
| `auth_tokens` (verify/reset) | unconsumed **and** unexpired | consumed **or** expired | **7 days** past death | `reapExpiredAuthTokens` |
| `auth_sessions` | unrevoked **and** unexpired | revoked **or** absolutely-expired | **30 days** past death | `reapExpiredAuthSessions` |
| `users` (anon, abandoned) | — | dormant-user GC (separate) | — | (existing) |

- **Tokens** are single-use + short-TTL (24 h verify / 60 min reset); a row older
  than 7 days is certainly dead. Only `SHA-256(token)` is stored — the raw token
  only ever existed in the email link.
- **Sessions** are *revoked* (set `revoked_at`), never deleted inline, so logout
  / reset / password-rotation leave an audit row; the janitor sweeps it after 30
  days. A **live** session (unrevoked + unexpired idle & absolute) is never
  reaped, and is also excluded from the `/api/auth/sessions` "active" list.

**Triggering:** `maybeReapAuth()` is called from `GET /api/auth/session` (hit on
nearly every page load while accounts are enabled), throttled to once per 5 min
per instance, so the tables get swept without a cron. The chat janitor
(`maybeReapStalePartials`) is unchanged.

**Right-to-erasure** (`hardDeleteUser`, `src/lib/gdpr/exportUser.ts`): a single
`DELETE FROM users` FK-cascades to sessions → messages/scoreVersions and to
`auth_sessions` / `oauth_accounts` / `auth_tokens`. It is atomic on its own (one
statement) — all-or-nothing without an explicit transaction. Credential material
(`password_hash`, every `token_hash`) is **redacted** from the export, never
included.

## Retention of PII (ip / user_agent)

`auth_sessions.ip` (truncated to /24 · /64 by the writer) and `user_agent` are
retained only for the life of the session row + the 30-day GC window, for the
account-settings "active sessions" list and abuse triage (legitimate-interest /
security basis). They are dropped when the row is reaped. `orchestrator_turns`
remains forensic-only and is excluded from the GDPR export.

## Breach response — what to rotate

Session tokens and email/reset tokens are stored **only as SHA-256 hashes**, and
passwords as **argon2id** — so a *database read* leak cannot be replayed directly.
Rotation targets the signing/API secrets (see `env-flags.md`).

| Compromise | Action | Effect |
|---|---|---|
| **DB read** (rows exfiltrated) | No forced rotation required (tokens hashed, passwords argon2id). Precaution: `UPDATE auth_sessions SET revoked_at=now` (force re-login everywhere) | Stolen rows can't be replayed; revoking sessions closes any TOCTOU window |
| **`SESSION_SECRET`** leak | Rotate it | Invalidates every anonymous `sl_uid` JWT (≤1 yr) — anon users re-mint. Does **not** touch `sl_sess` (opaque, DB-backed) |
| **`RECOVERY_SECRET`** leak | Rotate it (kept distinct from `SESSION_SECRET` for exactly this) | Kills every localStorage recovery token; users survive via cookie / password / OAuth |
| **CSRF token** theft | Nothing to rotate — CSRF is a random per-session double-submit token (cookie + matching header), not secret-derived; it's useless cross-origin and dies when its session is revoked | — |
| **Single `sl_sess` theft** | `POST /api/auth/sessions/revoke` (that id) or "log out all" | Kills just the stolen session (DB revoke makes the cookie inert) |
| **`RESEND_API_KEY`** leak | Rotate at Resend | Stops an attacker sending as your domain |
| **Google/GitHub client secret** leak | Rotate at the provider, update env | New OAuth exchanges only |
| **Suspected mass session compromise** | `UPDATE auth_sessions SET revoked_at=now` **and** rotate `SESSION_SECRET` | Forces re-login everywhere (both mechanisms) |

After any rotation, redeploy with the new env value; the change takes effect on
the next request (secrets are read per-request, not cached at boot beyond the
module singletons).
