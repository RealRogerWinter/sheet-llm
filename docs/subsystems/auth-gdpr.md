---
title: Auth, Sessions & GDPR
subsystem: auth-gdpr
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: e6f5a58
source_paths:
  - src/lib/auth/session.ts
  - src/lib/auth/account.ts
  - src/lib/auth/sessionStore.ts
  - src/lib/auth/routeGuard.ts
  - src/lib/auth/oauth/oauthLink.ts
  - src/lib/auth/recovery.ts
  - src/lib/auth/attachRecovery.ts
  - src/lib/auth/restoreRateLimit.ts
  - src/lib/auth/clientBackup.ts
  - src/components/RecoveryBoot.tsx
  - src/lib/gdpr/exportUser.ts
  - src/app/api/auth/restore/route.ts
  - src/app/api/me/export/route.ts
  - src/app/api/me/delete/route.ts
  - src/lib/db/schema.ts
  - src/app/api/chat/route.ts
related:
  - db-schema
  - chat-api
  - orchestrator
---

Identity in sheet-llm is **anonymous and cookie-less-by-default**: there are no
passwords, emails, or OAuth today. A user *is* a `crypto.randomUUID()` carried
as the `sub` of a `jose`-signed HS256 JWT in the httpOnly `sl_uid` cookie. To
survive cookie loss (Safari ITP eviction, manual clear, cross-device link), the
mint also hands the client a **separately-keyed single-use recovery token** that
lives in `localStorage`; on a boot with no session cookie, the client replays it
against `/api/auth/restore` to re-mint the same identity. On top of this sit two
**same-origin-gated GDPR endpoints** — `/api/me/export` (Art. 15/20 right of
access) and `/api/me/delete` (Art. 17 right to erasure, FK-cascade hard delete).
The defining invariant of the whole subsystem: the JWT is self-contained and
*verified*, never looked up — there is no `cookie_token` column — and the two
signing keys (`SESSION_SECRET`, `RECOVERY_SECRET`) are deliberately distinct so
they rotate independently.

## Entry points

| Surface | Symbol | File |
| --- | --- | --- |
| Identity resolver (every authed route) | `getOrCreateUserId` | `src/lib/auth/session.ts` |
| Read-only resolver (GDPR routes) | `getExistingUserId` | `src/lib/auth/session.ts` |
| Recovery flow with all defenses inline | `POST` | `src/app/api/auth/restore/route.ts` |
| GDPR export | `GET` | `src/app/api/me/export/route.ts` |
| GDPR delete | `DELETE` | `src/app/api/me/delete/route.ts` |
| Client half (interceptor + boot restore) | `installBackupInterceptor`, `bootRestoreIfNeeded` | `src/lib/auth/clientBackup.ts` |
| Client mount point (every route) | `RecoveryBoot` | `src/components/RecoveryBoot.tsx` |

## Key files

| Path | Role |
| --- | --- |
| `src/lib/auth/session.ts` | Session-cookie model. Signs/verifies the `sl_uid` HS256 JWT, mints anon users, sets the `sl_uid` (httpOnly) + `sl_present` (JS-readable sentinel) pair in lockstep. Exports `getOrCreateUserId`, `getExistingUserId`, `reissueSessionForRecovery`, `clearSessionCookie`, `SESSION_PRESENT_COOKIE_NAME`, the `SessionResult` interface, and the test-only `__TEST_COOKIE_NAME`. |
| `src/lib/auth/recovery.ts` | Recovery-token crypto, signed with `RECOVERY_SECRET` (a *different* key from `SESSION_SECRET`). `signRecoveryToken` mints token + a random `nanoid(24)` nonce; `verifyRecoveryToken` is pure crypto (no DB) returning `{ok,sub,nonce}` or a typed reason. Exports `RECOVERY_HEADER` (`'X-Session-Recovery'`), `RECOVERY_STORAGE_KEY` (`'sheet-llm:recovery'`), `RecoveryClaims`, `VerifyResult`. |
| `src/lib/auth/attachRecovery.ts` | `attachRecoveryHeader(response, session)` sets the `X-Session-Recovery` header on a response **only** when the `SessionResult` carried a fresh `recoveryToken`. No-op for returning users. Generic over `NextResponse \| Response`, returns the same response for chaining. |
| `src/lib/auth/restoreRateLimit.ts` | In-memory sliding-window limiter, `globalThis`-cached for HMR safety. Two buckets, `LIMIT=10` hits / `WINDOW_MS=5min`: per-IP (`checkIp`) and per-sub (`checkSub`). `extractClientIp` reads leftmost `x-forwarded-for` → `x-real-ip` → `'local'`, collapsing IPv6 to `/64`. Fails closed at `MAX_ENTRIES=10000`. `__resetForTesting()` wipes it. |
| `src/lib/auth/clientBackup.ts` | Client-only (`'use client'`). `installBackupInterceptor` wraps global `fetch` to stash any `X-Session-Recovery` header (length > 20) into `localStorage`; `bootRestoreIfNeeded` POSTs `/api/auth/restore` when the `sl_present` cookie is absent but a non-expired backup exists, reloading on 204 (unless a chat is in flight); `clearBackup` drops it. |
| `src/components/RecoveryBoot.tsx` | Mounts in `src/app/layout.tsx` on every route. Calls `installBackupInterceptor()` at module-import time and `bootRestoreIfNeeded()` in a `useEffect`. Renders `null`. |
| `src/lib/gdpr/exportUser.ts` | `buildUserExport` (full read of user + sessions + messages + scoreVersions, *including* soft-deleted, JSON kept opaque) and `hardDeleteUser` (deletes the `users` row, relies on FK `ON DELETE CASCADE`, counts rows first for the receipt). Exports `EXPORT_SCHEMA_VERSION=1` and the `UserExport` type. |
| `src/app/api/auth/restore/route.ts` | `POST /api/auth/restore`. Same-origin + body-size gate, per-IP limit, verify token, per-sub limit, atomic single-use nonce CAS `UPDATE`, then `reissueSessionForRecovery`. Status codes 204/400/401/409/410/413/429. |
| `src/app/api/me/export/route.ts` | `GET /api/me/export`. Same-origin gated, `getExistingUserId` (no mint), `buildUserExport`, returns a JSON attachment with a date-based filename and `Cache-Control: no-store`. |
| `src/app/api/me/delete/route.ts` | `DELETE /api/me/delete`. Requires `{confirm:'DELETE'}`, `getExistingUserId` (no mint), `hardDeleteUser`, `clearSessionCookie`, returns receipt + `clearLocalStorage:['sheet-llm:recovery']` body directive and a `Clear-Site-Data: "storage"` header. |
| `src/lib/db/schema.ts` | `users` table: `id` (text PK, the UUID), `externalId` (unique, reserved for future OAuth/email — always null today), `createdAt`, `lastSeenAt` (indexed `users_last_seen`), `lastRecoveryNonce` (last *consumed* nonce). `sessions.userId` → `users.id` `ON DELETE CASCADE`; `messages.sessionId`/`scoreVersions.sessionId` → `sessions.id` `ON DELETE CASCADE`. |
| `src/app/api/chat/route.ts` | Cross-subsystem seam: exports `checkSameOrigin` and `errorResponse`, reused by all three auth/me routes. Origin host must equal `host` header (else 403; malformed Origin → 400). `errorResponse(code,status,error,chatId?)` builds `{code, error}` JSON. |

## Core concepts & data flow

### Cookie pair: `sl_uid` + `sl_present`

`setSessionCookie` (private to `session.ts`) writes **two** cookies in lockstep:

- `sl_uid` — the signed JWT. `httpOnly`, `sameSite:'lax'`, `path:'/'`,
  `maxAge` = 1 year (`MAX_AGE_S = 60*60*24*365`), `secure` unless
  `SL_INSECURE_COOKIE_OK==='1'`. The JWT header carries `alg:'HS256'` and
  `kid` (`SESSION_KEY_KID`, default `'s1'`); the body sets only `sub`, `iat`,
  `exp`. Verified with a 30 s `clockTolerance` for multi-instance NTP drift.
- `sl_present` (`SESSION_PRESENT_COOKIE_NAME`) — a non-httpOnly sentinel with
  value `'1'`, same flags otherwise. Its sole job: let client JS answer "do we
  have a session?" via `clientBackup.hasSessionCookie()` (a `document.cookie`
  scan) **without** exposing the JWT. Without it, every boot fires a restore and
  burns the rate-limit budget.

Identity is purely the JWT `sub`. There is **no DB column that stores the
token** — the cookie is self-validating. `touchLastSeen` only bumps
`users.last_seen_at` and reports whether the row still exists.

### Get-or-create vs get-only

| Function | Missing/invalid cookie | Used by | Why |
| --- | --- | --- | --- |
| `getOrCreateUserId` | **Mints** a new anon user + cookie | chat route | a first-time visitor needs an identity to write against |
| `getExistingUserId` | Returns **`null`** | `/me/export`, `/me/delete` | minting-on-the-spot would let a cookie-less caller dump or delete a freshly-minted *phantom* while their real account sits untouched — a silent GDPR failure |

Both verify the JWT (`jwtVerify`, `algorithms:['HS256']`, 30 s tolerance), both
call `touchLastSeen`, and both treat a *gone* user row as "cookie outlived its
user": `getOrCreateUserId` falls through to mint a fresh (unrelated) identity;
`getExistingUserId` returns `null`.

### Separate-key recovery token

`createNewUser` signs **both** a session JWT *and* a recovery token *before*
inserting the `users` row, then returns `{userId, recoveryToken}`. The route
attaches the token via `attachRecoveryHeader`, the client interceptor stashes
it. Recovery tokens are HS256 over `RECOVERY_SECRET` (header `kid` =
`RECOVERY_KEY_KID`, default `'r1'`), body `{sub, nonce, iat, exp}`, 1-year exp.
Because the key differs from `SESSION_SECRET`, an XSS that exfiltrates the
`localStorage` token gets *one forgery of a recovery token*, not a session-cookie
forgery oracle — and `RECOVERY_SECRET` can be rotated to kill every backup
without invalidating a single active session.

### Single-use nonce CAS + rolling refresh

Each recovery token carries a random `nanoid(24)` nonce. `users.last_recovery_nonce`
stores the **last consumed** nonce. The restore route consumes it with one
atomic statement:

```
UPDATE users
   SET last_recovery_nonce = :nonce
 WHERE id = :sub
   AND (last_recovery_nonce IS NULL OR last_recovery_nonce != :nonce)
```

0 rows affected → either replay (the nonce already equals the column) or the user
is gone. A follow-up `SELECT` disambiguates: row missing → **410**
(`Account no longer exists`, never re-mints); row present → **409** (replay).
Both `createNewUser` and `reissueSessionForRecovery` mint a *fresh* token with a
*new* nonce, so on the happy path a valid backup always passes the CAS — **409
never fires for a legitimate user** (rolling refresh).

### `/api/auth/restore` defense pipeline

```
POST /api/auth/restore  { token }
  │
  ├─ checkSameOrigin .................. 403 (cross-origin) / 400 (bad Origin)
  ├─ content-length > 4096 ............ 413
  ├─ checkIp(extractClientIp) ......... 429   ← BEFORE any crypto/DB (DoS speedbump)
  ├─ read+parse body (zod, ≤4096) ..... 400 / 413
  ├─ verifyRecoveryToken .............. 401 (bad_signature/expired/malformed)
  ├─ checkSub(verified.sub) ........... 429   ← CRITICAL: AFTER verify, see gotchas
  ├─ atomic nonce CAS UPDATE
  │     ├─ rows == 0 → SELECT user
  │     │     ├─ absent  → 410 (do NOT re-mint)
  │     │     └─ present → 409 (replay)
  │     └─ rows == 1 → reissueSessionForRecovery(sub)
  └─ 204  + X-Session-Recovery: <fresh token>
```

The per-IP gate runs *before* jose so forged tokens never touch crypto; the
per-sub gate runs *after* verification so forged tokens can't pollute a victim's
sub bucket (this is the layer that catches a single stolen token replayed from a
botnet — each IP gets its first hit free).

### Client lifecycle (`clientBackup.ts` + `RecoveryBoot`)

```
module import (RecoveryBoot.tsx) ──► installBackupInterceptor()
     wraps globalThis.fetch: every response with X-Session-Recovery
     (token.length > 20) → writeBackup() to localStorage
        { token, exp: now + 1y }  under 'sheet-llm:recovery'

mount effect ──► bootRestoreIfNeeded()
     if hasSessionCookie() (sl_present present)  → return  (short-circuit)
     if no non-expired backup                    → return
     POST /api/auth/restore { token }
        204 → interceptor stashed new token; reload() UNLESS chat in flight
        401|410|409 → clearBackup()   (futile to retry)
        429|5xx     → keep backup, retry next boot
```

The reload is suppressed when `globalThis.__sheetLlmChatActive === true`
(mirrored from `src/lib/chat/state.ts`) so a restore mid-chat doesn't destroy an
optimistic prompt / in-progress assistant response.

### GDPR export & delete

`buildUserExport(db, userId)` returns `undefined` if the user is gone, else a
`UserExport` envelope (`schemaVersion: 1`, `exportedAt`, `user`, `sessions`,
`messages`, `scoreVersions`). It reads **all** sessions with **no `deletedAt`
filter** (Art. 15 covers soft-deleted data) and keeps `contentJson`/`scoreJson`
as the opaque DB strings (no re-parse — preserves fidelity, saves CPU). The
route emits it as a `Content-Disposition: attachment` JSON with a date-only
filename (`sheet-llm-export-YYYYMMDD.json`, UTC — no userId in the downloads
list) and `Cache-Control: no-store`.

`hardDeleteUser(db, userId)` counts sessions/messages/versions *first* (the
cascade obliterates everything in one statement), then deletes **only** the
`users` row — SQLite FK `ON DELETE CASCADE` sweeps `sessions → messages` and
`sessions → scoreVersions`. Returns `{ok:true, deletedSessions, deletedMessages,
deletedVersions}` or `{ok:false, reason:'user_not_found'}`. The route then
`clearSessionCookie()`s both cookies and responds with the receipt plus
`clearLocalStorage:['sheet-llm:recovery']` and `Clear-Site-Data: "storage"`, so
the deleted user cannot ghost-restore on the next boot.

## Invariants & gotchas

- **Route-handler-only cookie writes.** `getOrCreateUserId` /
  `reissueSessionForRecovery` / `clearSessionCookie` call `cookies().set`/`.delete`,
  which throws `CookiesOutsideOfRequestHandlerError` in a Server Component render
  context and is a no-op once the response stream has flushed. Call them from a
  Route Handler or Server Action, **before SSE starts**.
- **Two distinct ≥32-byte secrets.** `SESSION_SECRET` and `RECOVERY_SECRET` must
  differ and each be ≥32 bytes (HS256 / RFC 7518 §3.2). `createNewUser` signs
  *both* tokens **before** inserting the `users` row specifically so a
  misconfigured secret surfaces as an error instead of leaking an orphan row on
  every retry.
- **`SL_INSECURE_COOKIE_OK='1'` is the only Secure-off switch** (localhost dev).
  Default is Secure-on. `sameSite` is always `'lax'`, `path '/'`, `maxAge` 1 year.
- **`checkSub` must run after `verifyRecoveryToken`.** The route comments this as
  CRITICAL: a pre-verification sub check would let an attacker forge tokens for a
  victim's `sub` and rate-limit the victim's *real* restores.
- **410 deliberately does not re-mint.** Minting a new identity on a gone user
  would attach an attacker's `localStorage` token to a fresh anon account. The
  client clears the backup on 401/410/409 but **retains** it on 429/5xx.
- **Export does not filter `deletedAt`; JSON is opaque.** Art. 15 covers
  soft-deleted data; `contentJson`/`scoreJson` are passed through verbatim.
- **Delete leans entirely on FK cascade** (`PRAGMA foreign_keys=ON`).
  `hardDeleteUser` deletes only the `users` row; if cascade were off, children
  would orphan. The `{confirm:'DELETE'}` literal is the **load-bearing
  server-side guard**, not just the UI modal.
- **The restore reload loop is broken only by the `sl_present` short-circuit.**
  Rolling refresh means a fresh nonce always passes the CAS, so 409 never stops
  the loop — only the per-IP limiter (10/5min) would if the sentinel guard
  regressed.
- **The limiter is single-process, in-memory.** Behind N nodes the effective
  budget is `10N` per 5-min window — **not** a distributed limiter. A Redis swap
  is flagged P1. `__resetForTesting()` wipes both buckets.
- **`externalId` is reserved.** Unique column for a future email/OAuth flow so
  auth can ship without a migration; today it is always `null`.

## Env flags

| Flag | Default | Effect |
| --- | --- | --- |
| `SESSION_SECRET` | **required** (throws if missing/<32 B) | HS256 key for the `sl_uid` session JWT. |
| `RECOVERY_SECRET` | **required** (throws if missing/<32 B) | HS256 key for recovery tokens; **must differ** from `SESSION_SECRET` so the two rotate independently. |
| `SESSION_KEY_KID` | `s1` | `kid` header on the session JWT, for future multi-key rotation. |
| `RECOVERY_KEY_KID` | `r1` | `kid` header on recovery tokens, for rotation without invalidating active backups. |
| `SL_INSECURE_COOKIE_OK` | unset (Secure on) | Set to `'1'` to drop the `Secure` flag on both cookies for localhost dev. |

## How to extend / common tasks

- **Add a new authed route that may create a user** → call
  `getOrCreateUserId()`, then wrap your `NextResponse` with
  `attachRecoveryHeader(res, session)` so a freshly minted user's backup lands in
  `localStorage`. Do this from a Route Handler, before any streaming.
- **Add a route that must operate on an *existing* user only** (anything
  destructive or PII-dumping) → use `getExistingUserId()` and 401 on `null`; do
  **not** mint. Gate it with `checkSameOrigin(request)` from the chat route.
- **Add a field to the GDPR export** → extend `UserExport` and the `select(...)`
  projections in `buildUserExport`; if the *wire shape* changes meaningfully,
  bump `EXPORT_SCHEMA_VERSION`. Do not add a `deletedAt` filter.
- **Add a child table that holds user data** → give it an FK to `sessions` (or a
  new FK to `users`) with `onDelete: 'cascade'` in `src/lib/db/schema.ts`, **and**
  add it to `buildUserExport` *and* the `hardDeleteUser` receipt counts —
  otherwise it leaks from the export and skews the deletion receipt.
- **Implement real auth (email/OAuth)** → populate `users.externalId` (already
  unique); no migration needed for the column itself.
- **Make the limiter distributed** → swap `restoreRateLimit.ts`'s `globalThis`
  Maps for Redis behind the same `checkIp`/`checkSub` signatures; the route does
  not need to change.
- **Rotate a key** → multi-key verification is not yet implemented, but the `kid`
  header is already emitted on both token types so a candidate-set verify loop can
  be added without breaking active tokens/backups.

## Testing

| Test | Covers |
| --- | --- |
| `tests/integration/auth/session.test.ts` | `getOrCreateUserId` / `getExistingUserId`, cookie minting & JWT verification |
| `tests/integration/auth/restore.test.ts` | `/api/auth/restore` status codes, nonce single-use CAS, rate limits |
| `tests/unit/auth/recovery.test.ts` | `signRecoveryToken` / `verifyRecoveryToken` crypto + claim validation |
| `tests/unit/auth/restoreRateLimit.test.ts` | per-IP/per-sub buckets, IPv6 `/64`, fail-closed, prune |
| `tests/unit/auth/clientBackup.test.ts` | interceptor stash, `bootRestoreIfNeeded` short-circuit/restore/clear logic |
| `tests/integration/api-me-gdpr.test.ts` | `/api/me/export` and `/api/me/delete` (`buildUserExport` / `hardDeleteUser` cascade + receipts) |

## Accounts — signup, login, OAuth, email, settings (the accounts milestone)

The anonymous identity + recovery + GDPR machinery above is the **foundation**;
the accounts milestone built the full user-account surface on top, **dark behind
`SL_ACCOUNTS_ENABLED`**. Signup **claims** the current anonymous `users` row in
place (sets `email` + `password_hash` + `claimed_at`), so a visitor's
scores/sessions carry over with no data move — and once claimed, the anonymous
recovery path is **refused** (`restore` returns `account_claimed`, and
`getRequestUser` ignores a claimed account's stale `sl_uid`).

- **Identity** (`session.ts:getRequestUser`): a DB-backed revocable `sl_sess`
  (opaque, SHA-256-stored) authenticates; a `sl_uid` authorizes only *unclaimed*
  anon identities. Mint / rotate / revoke + idle/absolute expiry in `sessionStore.ts`.
- **Routes** (`src/app/api/auth/*`). Every MUTATING route is behind
  `guardAuthMutation` (404-when-disabled + strict same-origin + JSON-only +
  double-submit CSRF): `signup`, `login`, `logout`, `logout-all`, `forgot`,
  `reset`, `verify-email` (+ `/send`), `change-password`, `change-email`, and
  `sessions/revoke`. The GET endpoints gate differently: `session` returns
  `{enabled:false}` when off (never 404); `sessions` 404s when disabled; the
  OAuth `start`/`callback` 404 when disabled and bind CSRF to a single-use
  `state` cookie (a top-level provider redirect can't carry a double-submit
  token).
- **Passwords** argon2id (`password.ts`); **email** via a swappable provider with
  single-use SHA-256 tokens (`authTokens.ts`); **OAuth** Google + GitHub via
  `arctic` with verified-email-only linking (`oauth/oauthLink.ts`).
- **Rate-limit**: per-IP + per-email (`authRateLimit.ts`) + an outbound-email send
  budget (`emailRateLimit.ts`). **Frontend**: `useAuthStore`/`useAuthSync` +
  `AuthNavButton`/`AuthModal`, the `/signup` `/reset` `/verify-email` pages, and
  the `/settings` account section.

Operational companions: **[env-flags → Accounts](../reference/env-flags.md#accounts-signup--login--oauth--settings--paywall--durability)**
(every env var + the launch procedure), **[auth-data-lifecycle.md](./auth-data-lifecycle.md)**
(GC retention + breach/secret rotation), and the **[durability runbook](../guides/durability-runbook.md)**
(the hard launch gate). The GDPR export/delete below already counts + redacts the
new account tables (`auth_sessions`, `oauth_accounts`, `auth_tokens`).

## Related files / See also

- `src/app/api/chat/route.ts` — `checkSameOrigin`, `errorResponse` (the shared
  same-origin gate and JSON error envelope every auth/me route reuses).
- `src/lib/db/schema.ts` — `users`, `sessions`, `messages`, `scoreVersions` and
  their cascade wiring.
- `src/lib/chat/state.ts` — source of the `__sheetLlmChatActive` flag the
  restore reload guard reads.
- `src/app/layout.tsx` — mounts `RecoveryBoot` on every route.
- `src/lib/orchestrator/README.md` — the chat orchestrator that `getOrCreateUserId`
  fronts.
