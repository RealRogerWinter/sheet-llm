---
title: Auth, Sessions & GDPR — context card
subsystem: auth-gdpr
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/auth/session.ts
  - src/lib/auth/account.ts
  - src/lib/auth/sessionStore.ts
  - src/lib/auth/routeGuard.ts
  - src/lib/auth/password.ts
  - src/lib/auth/authTokens.ts
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

Anonymous cookie-less identity is the FOUNDATION: a `crypto.randomUUID()` is the `sub` of a jose HS256 JWT in httpOnly `sl_uid`; a separately-keyed single-use recovery token in localStorage survives cookie loss; same-origin GDPR export (Art.15/20) + hard-delete (Art.17). No `cookie_token` column — the JWT is verified, never looked up. The **accounts** milestone built a full email/password + OAuth account surface ON TOP, dark behind `SL_ACCOUNTS_ENABLED` (see the Accounts section). Canonical doc: `docs/subsystems/auth-gdpr.md`.

## Files
- `src/lib/auth/session.ts` — `sl_uid` JWT sign/verify; mints anon users; sets `sl_uid`(httpOnly)+`sl_present`(sentinel) pair. **`getRequestUser`** (THE route resolver → `RequestUser{userId,authenticated,recoveryToken?}`: `sl_sess` > unclaimed `sl_uid` > mint; CLAIMED `sl_uid` refused), **`getExistingRequestUser`**(no mint). Legacy `getOrCreateUserId`/`getExistingUserId` retained but `@internal` (anon-mint + tests; `identityResolverGuard.test.ts` bans from routes). Also `reissueSessionForRecovery`, `clearSessionCookie`, `SESSION_PRESENT_COOKIE_NAME`, `SessionResult`, `RequestUser`.
- `src/lib/auth/account.ts` — `isAccountsEnabled()` (`SL_ACCOUNTS_ENABLED`), `normalizeEmail` (lowercase — every writer funnels through it), `findUserByEmail`, `getAccountById`, `claimAccountWithPassword` (claims the CURRENT anon row in place — sets email+`password_hash`+`claimed_at`), `isUniqueViolation`.
- `src/lib/auth/sessionStore.ts` — DB-backed REVOCABLE `sl_sess` login sessions (opaque 32B token, only SHA-256 stored). `createAuthSession`, `verifyAuthSession` (the authed half of `getRequestUser`; throttled idle-slide), `revokeCurrentAuthSession`, `revokeAllAuthSessions`, `revokeAuthSessionById`, `listAuthSessions`, `clearAuthSessionCookies`, `AUTH_SESSION_COOKIE_NAME`(`sl_sess`)+`AUTH_PRESENT_COOKIE_NAME`.
- `src/lib/auth/routeGuard.ts` — `guardAuthMutation` (404-when-disabled → strict same-origin 403 → JSON-only 415 → double-submit CSRF 403) gating EVERY mutating auth route; `readJsonBody` (≤4KB), `authError`, `rateLimited`, `clientUserAgent`. CSRF primitives live in `httpGuards.ts` (`issueCsrfToken`/`verifyCsrf`, `CSRF_COOKIE_NAME`/`X-CSRF-Token`).
- `src/lib/auth/password.ts` — argon2id (`hashPassword`/`verifyPassword`/`needsRehash`, `ARGON2_PARAMS`).
- `src/lib/auth/authTokens.ts` — single-use SHA-256 email-verify / password-reset tokens (`createAuthToken`/`consumeAuthToken` CAS / `invalidateUserTokens`, `TokenPurpose`). Email send via swappable provider (`src/lib/auth/email/`: console + resend) with `emailRateLimit.ts` send budget; `authRateLimit.ts` = per-IP + per-email throttle; `disposableDomains.ts` blocks throwaway emails.
- `src/lib/auth/oauth/oauthLink.ts` — `resolveOAuthLogin` (verified-email-only linking → `OAuthLinkOutcome`); siblings `oauth/config.ts` (provider cfg, `buildAuthorizationURL`, token exchange), `oauth/oauthState.ts` (single-use `state` cookie CSRF + `sanitizeReturnTo`), `oauth/oauthUser.ts` (`exchangeCodeForUser`). Google + GitHub via `arctic`.
- `src/lib/auth/recovery.ts` — recovery crypto over `RECOVERY_SECRET` (≠ SESSION). `signRecoveryToken`(→token+`nanoid(24)` nonce), `verifyRecoveryToken`(pure crypto, no DB), `RECOVERY_HEADER='X-Session-Recovery'`, `RECOVERY_STORAGE_KEY='sheet-llm:recovery'`.
- `src/lib/auth/attachRecovery.ts` — `attachRecoveryHeader(res, session)` sets header iff a fresh token present.
- `src/lib/auth/restoreRateLimit.ts` — in-memory globalThis limiter, 10/5min × {IP,sub}. `checkIp`/`checkSub`/`extractClientIp`(IPv6→/64)/`__resetForTesting`. Fail-closed at 10000.
- `src/lib/auth/clientBackup.ts` — `'use client'`. `installBackupInterceptor`(fetch→stash header), `bootRestoreIfNeeded`(POST restore if no `sl_present` + backup), `clearBackup`.
- `src/components/RecoveryBoot.tsx` — mounts in `app/layout.tsx` everywhere; install at import, boot-restore in effect.
- `src/lib/gdpr/exportUser.ts` — `buildUserExport`(incl. soft-deleted, opaque JSON; now also exports the account `users` columns email/emailVerified/tier/displayName/claimedAt + the `authSessions`/`oauthAccounts`/`authTokens` arrays — every `password_hash`/`token_hash` REDACTED), `hardDeleteUser`(NO explicit txn — a single atomic `DELETE FROM users` FK-cascades to chat sessions AND auth_sessions/oauth_accounts/auth_tokens; counts first → receipt incl. `deletedAuthSessions`/`deletedOauthAccounts`/`deletedAuthTokens`). `EXPORT_SCHEMA_VERSION=1`, `UserExport`.
- `src/app/api/auth/restore/route.ts` — POST; same-origin+size→IP-limit→verify→sub-limit→nonce CAS→reissue. Now ALSO refuses a CLAIMED identity: the claim check (`isNull(email/passwordHash/claimedAt)`) is folded INTO the CAS predicate (atomic, no TOCTOU) → 409 `account_claimed`. 204/400/401/409(`invalid_request` replay | `account_claimed`)/410/413/429.
- `src/app/api/me/export/route.ts` — GET; same-origin, `getExistingRequestUser`, JSON attachment, `no-store`.
- `src/app/api/me/delete/route.ts` — DELETE `{confirm:'DELETE'}`; `getExistingRequestUser`, `hardDeleteUser`, `clearSessionCookie`+`clearAuthSessionCookies`, `Clear-Site-Data:"storage"` + receipt (incl. account counts) + `clearLocalStorage` body.
- `src/lib/db/schema.ts` — `users`(id PK, externalId unique/null, createdAt, lastSeenAt idx, lastRecoveryNonce; **+accounts**: email unique-lowercased/null, emailVerified, passwordHash(argon2id)/null, tier default `free`, displayName, claimedAt) — pure ADD COLUMN, anon rows stay valid. **New tables** `auth_sessions`(revocable login, SHA-256 tokenHash unique, absolute+idle expiry, revokedAt audit), `oauth_accounts`(unique provider+providerAccountId), `auth_tokens`(single-use, SHA-256 tokenHash, consumedAt) — all FK `users.id` ON DELETE CASCADE. sessions/messages/scoreVersions cascade as before.
- `src/app/api/chat/route.ts` — exports `checkSameOrigin`, `errorResponse({code,error})` reused by all me/auth routes.

## Env flags
- `SESSION_SECRET` — required, ≥32B; session JWT key.
- `RECOVERY_SECRET` — required, ≥32B, MUST differ from SESSION; recovery key.
- `SESSION_KEY_KID`=`s1`, `RECOVERY_KEY_KID`=`r1` — JWT `kid` for future rotation.
- `SL_INSECURE_COOKIE_OK` — unset (Secure on); `'1'` drops Secure for localhost. SameSite always `lax`, maxAge 1y.
- **Accounts** (full list + launch steps in `docs/reference/env-flags.md` → Accounts section): `SL_ACCOUNTS_ENABLED` (master kill — off = `/api/auth/*` mutations 404, GET `session` returns `{enabled:false}`); `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `OAUTH_REDIRECT_BASE_URL` (OAuth; a provider is "configured" only when its pair is set); `RESEND_API_KEY`+`EMAIL_FROM` (real email; otherwise the console provider logs links); `APP_BASE_URL` (link base).

## Gotchas
- Cookie writes (`getRequestUser`/`reissue`/`clearSessionCookie`/`clearAuthSessionCookies`) are Route-Handler/Server-Action only — throw in Server Components, no-op after stream flush. Call before SSE.
- `getExistingRequestUser` returns null (never mints) — export/delete use it so a cookie-less caller can't dump/delete a phantom. `getRequestUser` mints anon (chat). Do NOT use the `@internal` legacy `getOrCreateUserId`/`getExistingUserId` in routes — a guard test fails the build.
- **`sl_uid` is claim-gated.** A stale `sl_uid` (unrevocable 1y bearer JWT) for a CLAIMED account must NOT authenticate it — `getRequestUser`/`getExistingRequestUser` refuse it; the restore route refuses it ATOMICALLY (claim predicate folded into the nonce CAS) → 409 `account_claimed`. Real accounts authenticate via the revocable DB-backed `sl_sess`.
- `checkSub` MUST run AFTER `verifyRecoveryToken` (else forged tokens pollute a victim's sub bucket). Route comments this CRITICAL.
- Restore 410 (user gone) does NOT re-mint. Client clears backup on 401/410/409 (incl. `account_claimed`); keeps on 429/5xx.
- Reload loop broken only by `sl_present` short-circuit (rolling refresh → fresh nonce always passes CAS, 409 never stops it). Reload skipped when `globalThis.__sheetLlmChatActive`.
- Delete leans on SQLite FK `ON DELETE CASCADE` (now also auth_sessions/oauth_accounts/auth_tokens); a single `DELETE FROM users` is the only write (atomic, no txn). `{confirm:'DELETE'}` literal is the load-bearing server guard.
- `password_hash` and every `token_hash` are NEVER exported (credential material, not personal data); the GDPR export carries auth-session/token METADATA only. Both rate limiters are single-process, in-memory (10N behind N nodes).

## Accounts — signup/login/OAuth/email/settings (behind `SL_ACCOUNTS_ENABLED`)
Built ON the anon foundation; signup CLAIMS the current anon `users` row in place (email+`password_hash`+`claimed_at`) so scores/sessions carry over with no data move, after which the anon recovery path is refused (`account_claimed`).
- **Identity**: `getRequestUser` (session.ts) — revocable DB-backed `sl_sess` (SHA-256-stored, mint/rotate/revoke + idle/absolute expiry in `sessionStore.ts`: 90d absolute / 12h ephemeral when remember-me off / 14d sliding idle) authenticates; `sl_uid` authorizes only UNCLAIMED anon.
- **Routes** `src/app/api/auth/*` — every MUTATING route POST behind `guardAuthMutation` (404-off + strict same-origin + JSON-only + double-submit CSRF): `signup`/`login`/`logout`/`logout-all`/`forgot`/`reset`/`verify-email`(+`/send`)/`change-password`/`change-email`/`sessions/revoke`. GETs differ: `session` returns `{enabled:false}` when off (never 404); `sessions` 404s; `oauth/[provider]/{start,callback}` 404 when off and bind CSRF to a single-use `state` cookie (a top-level provider redirect can't carry a double-submit token).
- **Crypto/abuse**: argon2id (`password.ts`); single-use SHA-256 email tokens (`authTokens.ts`) + swappable email provider; Google+GitHub via `arctic`, verified-email-only linking (`oauth/oauthLink.ts`); per-IP+per-email + email-send budgets (`authRateLimit.ts`/`emailRateLimit.ts`); `disposableDomains.ts`.
- **Frontend**: `useAuthStore`/`useAuthSync`, `AuthNavButton`/`AuthModal`, `/signup` `/reset` `/verify-email` pages, `/settings` account section (`AccountSettings`).
- Companions: `docs/reference/env-flags.md` (Accounts section), `docs/subsystems/auth-data-lifecycle.md` (GC + breach/rotation), `docs/guides/durability-runbook.md` (launch gate).

## When editing X, also update Y
- New user-data child table → add FK `onDelete:'cascade'` (schema.ts) AND add to `buildUserExport` AND `hardDeleteUser` receipt counts (this is why the three account tables already appear in both).
- New `UserExport` field → update `select(...)` projection; bump `EXPORT_SCHEMA_VERSION` if wire shape changes. Never add a `deletedAt` filter. NEVER add `password_hash`/`token_hash`.
- Rename `RECOVERY_HEADER`/`RECOVERY_STORAGE_KEY` → update `clientBackup.ts`, `attachRecovery.ts`, restore route, delete-route `clearLocalStorage`.
- Change `sl_present` name → update `clientBackup.hasSessionCookie` (hardcoded literal) + `SESSION_PRESENT_COOKIE_NAME`.
- New authed route → resolve via `getRequestUser`/`getExistingRequestUser`; gate with `checkSameOrigin` from chat route; `attachRecoveryHeader` if it can mint. A mutating AUTH route → gate with `guardAuthMutation` instead.

## Tests
`tests/integration/auth/{session,restore,sessionResolver,authRoutes,accountRoutes,oauthRoutes,emailFlows}.test.ts`, `tests/unit/auth/{recovery,restoreRateLimit,clientBackup,identityResolverGuard}.test.ts`, `tests/integration/api-me-gdpr.test.ts`.

## Related cards
db-schema · chat-api · orchestrator · app-shell
