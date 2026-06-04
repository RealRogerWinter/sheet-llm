---
title: App Shell, Routes & Boot — Context Card
subsystem: app-shell
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/app/layout.tsx
  - src/app/page.tsx
  - src/app/settings/SettingsContent.tsx
  - src/app/help/HelpContent.tsx
  - src/instrumentation.ts
  - src/components/RecoveryBoot.tsx
  - src/components/HomeClient.tsx
  - src/components/AppHeader.tsx
  - src/components/ScoreStage.tsx
  - src/components/auth/AuthNavButton.tsx
  - src/components/auth/AuthModal.tsx
  - src/app/api/chat/route.ts
  - src/app/api/chat/confirm-replacement/route.ts
  - src/app/api/sessions/[id]/versions/route.ts
  - src/app/api/me/delete/route.ts
  - src/lib/auth/session.ts
  - src/lib/auth/attachRecovery.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/generationTier.ts
related:
  - orchestrator
  - conversations-persistence
  - score-versions-db
  - auth-session-recovery
  - auth-gdpr
  - editor-state
  - import-export
---

# App Shell — Context Card

Next.js 16 App Router shell: three pages (`/` editor, `/settings` account+GDPR, `/help` public user guide), root-layout boot, server-startup instrumentation, and all `/api/**` route handlers. No middleware — cross-cutting concerns are per-handler.

## Key files
- `src/app/layout.tsx` — `RootLayout`; inline theme-flash `<script>` sets `data-theme` pre-paint; mounts `<RecoveryBoot/>`; `<html suppressHydrationWarning>`.
- `src/app/page.tsx` → `src/components/HomeClient.tsx` — the `/` SPA; HomeClient calls 8 store/sync hooks (incl. `useAuthSync`) then renders SessionSidebar/AppHeader/Hero/ChatHistoryPanel/DebugPanel/AuthModal.
- `src/components/AppHeader.tsx` — right cluster of buttons + `AuthNavButton` (Log in/Sign up vs email/Log out; hidden when accounts disabled or auth still loading).
- `src/components/Hero.tsx` — editor surface; `exportScore = editedScore ?? scoreJson`, `displayedAbc = pendingProposal?.abc ?? abc`; hosts ⌘K palette + orchestrator overlays. UI gated on `abc`.
- `src/components/ScoreStage.tsx` — crossfades on `epoch` change, NOT on `abc` change. Renders the score READ-ONLY (no click/interactive/reveal) while a sectional generation streams (`streamProgress !== undefined`); editing unlocks on the terminal `done` frame.
- `src/app/help/HelpContent.tsx` (+ `help/page.tsx`) — `/help` public user guide; renders `HELP_SECTIONS` (`src/lib/help/content.ts`, prose in `sections.json`) via react-markdown + remark-gfm.
- `src/components/RecoveryBoot.tsx` — module-load `installBackupInterceptor()` + mount `bootRestoreIfNeeded()`; lives in layout so `/settings` gets recovery too.
- `src/instrumentation.ts` — `register()`: `ensureMigrationsApplied()` (unwrapped) + `reapStalePartials()` (try/catch); guarded by `NEXT_RUNTIME==='nodejs'`.
- `src/app/api/chat/route.ts` — route kernel + shared util module (POST/GET/DELETE); resolves identity via `getRequestUser()`; `ChatRequestSchema` now also accepts optional `targetRegion {start,endMeasureIdx}` (D5 right-click AI) and resolves a paywall tier (`resolveGenerationTier`); includes `respondWithScoreStream` SSE responder (emits `section` frames then `done`/`error`, sets `X-Stream-Kind: score`); `maxDuration` 300 s; body cap 1 MB.
- `src/app/api/chat/confirm-replacement/route.ts` — accept/reject/dont_ask gate resolver (`getRequestUser`).
- `src/app/api/sessions/[id]/versions/route.ts` — CAS score-version write (semantic validate); `getRequestUser`.
- `src/app/api/me/delete/route.ts`, `.../me/export` — GDPR; use `getExistingRequestUser()` (never-mint). delete also `clearAuthSessionCookies()` + reports `deletedAuthSessions`/`deletedOauthAccounts`/`deletedAuthTokens`.
- `src/lib/auth/session.ts` — `getRequestUser` (THE route resolver → `RequestUser{userId,authenticated,recoveryToken?}`; DB-backed `sl_sess` > unclaimed `sl_uid` > mint; refuses a claimed `sl_uid`) / `getExistingRequestUser` (never-mint). Legacy `getOrCreateUserId`/`getExistingUserId` are `@internal` (guard test bans from routes). Cookies `sl_uid`+`sl_present`; auth-session mint/verify in `sessionStore.ts`.
- `src/lib/auth/attachRecovery.ts` — `attachRecoveryHeader(res, session)`.
- `src/lib/orchestrator/flags.ts` — per-request flag getters.
- `src/lib/orchestrator/generationTier.ts` — `resolveGenerationTier(userId, debugTier?)` (paywall tier; ignores the client `debug.generationTier` in prod unless `SL_ALLOW_TIER_OVERRIDE` via `isTierOverrideAllowed`).

## Key exports / types
- From `chat/route.ts`: `checkSameOrigin`, `errorResponse(code,status,error,chatId?)`, `UuidSchema`, `synthToolUseId()` (`toolu_orch_*`), `forkSeedToolUseId()` (`toolu_fork_*`); `POST/GET/DELETE`.
- `getRequestUser()` → `RequestUser` (mints anon when no `sl_sess`/valid anon `sl_uid`), `getExistingRequestUser()` (never mints, 401 path). Legacy `getOrCreateUserId`/`getExistingUserId` are `@internal`.
- `attachRecoveryHeader`; `getOrchestratorMode()`, `isGhostPreviewEnabled()`, `isReplacementGateEnabled()`, `isNewToolDispatchEnabled()`, `isSectionalGenEnabled()`.
- Types in `src/lib/shared/types.ts`: `ChatErrorCode` (incl. `output_too_large`), `ChatResponse`, `TranscriptResponse`, `ConfirmReplacementResponse`.

## Env flags (default → effect)
- `ORCHESTRATOR_KILL` unset → =1 forces mode `off` (highest precedence).
- `ORCHESTRATOR_ENABLED` unset(enabled) → false/0 → `off`.
- `ORCHESTRATOR_MODE` unset→`primary` → `shadow` runs alongside legacy (legacy wins).
- `SL_GHOST_PREVIEW` **ON** → =0/false silent-commit.
- `SL_REPLACEMENT_GATE` **ON** → =0/false legacy silent-replace.
- `SL_NEW_TOOL_DISPATCH` **ON** → =0/false legacy Haiku classifier.
- `SL_SECTIONAL_GEN` **ON** → =0/false falls back to single-shot `runGenerateComplex` for new-score generation.
- `SL_ALLOW_TIER_OVERRIDE` unset(prod ignores client `debug.generationTier`) → =1 honors it (non-prod always honors). Paywall bypass guard — see `generationTier.ts`.
- `SL_ACCOUNTS_ENABLED` unset(accounts dark) → gates the whole `/api/auth/*` family + `AuthNavButton`/`AuthModal` (owned by auth-gdpr; listed here because the shell mounts the UI).
- `SESSION_SECRET` required ≥32B; `RECOVERY_SECRET` required, separate.
- `SL_INSECURE_COOKIE_OK` unset(Secure) → =1 drops Secure (localhost).
- `ANTHROPIC_API_KEY` unset → legacy client = `stub`, `debug.model=null`.

## Gotchas
- `chat/route.ts` is a shared import hub — 11 routes re-import its utils; changing `errorResponse`/`ChatErrorCode` ripples everywhere.
- Score-stream responses set `X-Stream-Kind: score`; `OutputTruncatedError` maps to HTTP 422 `output_too_large` (not a provider-degradation event); `countUserTextTurns` counts only ANSWERED turns so failed retries don't consume the 20-turn cap.
- `requiresConfirmation` persists the candidate row but does NOT bump `head_version_id`; hydration + freshness key off the head, not the latest row.
- Ghost preview + replacement gate are mutually exclusive; gate wins.
- `toolu_orch_*` ids are NOT Anthropic anchors (stripped by `prepareMessagesForLLM`); `toolu_fork_*` ARE.
- `/api/me/{export,delete}` MUST use `getExistingRequestUser()` or you mint+nuke a phantom (GDPR Art.17 footgun).
- `getRequestUser` claim-gates `sl_uid`: a stale `sl_uid` for a CLAIMED (email/pw/OAuth) account is REFUSED (it's an unrevocable 1y bearer = passwordless login) — authed accounts go through the revocable `sl_sess`. Only the `@internal` legacy resolvers are un-gated; an `identityResolverGuard` test bans them from route code.
- chat POST `editedScore` = schema-only validate; `/sessions/:id/versions` = full semantic validate.
- Same-origin only enforced when both Origin+Host present; CSRF mitigation, not authz.
- `getRequestUser()` must run before the response stream opens (Next 16 cookie-set-after-flush).

## When editing X, also update Y
- Change `errorResponse` signature / `ChatErrorCode` → audit all 11 importers + `src/lib/shared/types.ts`.
- Add a score-mutation path that should crossfade → bump chat-store `epoch` (`ScoreStage`).
- Persist a new score → go through `/sessions/:id/versions` CAS write, never a bare head update.
- Add an env flag → add getter to `flags.ts` (per-request, no caching).
- Add a top-level page → recovery already covered by `RecoveryBoot`; do NOT re-add interceptor.
- New `/api/**` route → resolve identity with `getRequestUser`/`getExistingRequestUser`, NOT the `@internal` legacy resolvers (guard test enforces).

## Related cards
orchestrator · conversations-persistence · score-versions-db · auth-session-recovery · auth-gdpr · editor-state · import-export
