---
title: App Shell, Routes & Boot
subsystem: app-shell
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/app/layout.tsx
  - src/app/page.tsx
  - src/app/settings/page.tsx
  - src/app/settings/SettingsContent.tsx
  - src/app/help/page.tsx
  - src/app/help/HelpContent.tsx
  - src/instrumentation.ts
  - src/components/RecoveryBoot.tsx
  - src/components/HomeClient.tsx
  - src/components/AppHeader.tsx
  - src/components/ScoreStage.tsx
  - src/components/auth/AuthNavButton.tsx
  - src/components/auth/AuthModal.tsx
  - src/components/auth/AccountSettings.tsx
  - src/app/api/chat/route.ts
  - src/app/api/chat/confirm-replacement/route.ts
  - src/app/api/sessions/[id]/versions/route.ts
  - src/app/api/me/delete/route.ts
  - src/app/api/import/route.ts
  - src/lib/auth/session.ts
  - src/lib/auth/attachRecovery.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/generationTier.ts
related:
  - orchestrator
  - conversations-persistence
  - score-versions-db
  - auth-session-recovery
  - music-score-model
  - editor-state
  - import-export
---

# App Shell, Routes & Boot

The Next.js 16 (App Router) shell that hosts the editor. It is deliberately
thin: **three pages** — `/` (the full single-page editor),
`/settings` (GDPR export/delete), and `/help` (the user guide) — plus the boot wiring in
`src/app/layout.tsx` and `src/instrumentation.ts`, and the
`src/app/api/**/route.ts` handlers that drive chat, sessions, versioning,
import, recovery, and account export/delete. There is **no middleware
file**; cross-cutting concerns (same-origin, recovery-token attachment,
identity) are applied per-handler. `src/app/api/chat/route.ts` is both the
central chat endpoint *and* the shared utility module every other route
imports from.

## Entry points

| File | What it boots |
| --- | --- |
| `src/app/layout.tsx` (`RootLayout`) | Inline theme-flash guard, Geist fonts, global CSS, mounts `<RecoveryBoot/>`. |
| `src/instrumentation.ts` (`register`) | Once per server process: Drizzle migrations + stale-`partial` janitor. |
| `src/app/page.tsx` → `src/components/HomeClient.tsx` | The editor SPA at `/`. |
| `src/app/api/chat/route.ts` | The route kernel (orchestrator/legacy dispatch, SSE converse streaming, SSE score-stream) + the shared `checkSameOrigin` / `errorResponse` / `UuidSchema` / `synthToolUseId` / `forkSeedToolUseId` exports. |
| `src/components/Hero.tsx` | The editor composition surface (everything gated behind `abc` present). |

## Key files

| Path | Role |
| --- | --- |
| `src/app/layout.tsx` | `RootLayout`. Injects a synchronous inline `themeBootstrap` `<script dangerouslySetInnerHTML>` in `<head>` that reads `localStorage['sheet-llm:theme']` (falls back to `prefers-color-scheme`) and sets `data-theme` on `<html>` before first paint. Wires Geist fonts + `globals.css`, `abcjs/abcjs-audio.css`, `@/styles/abcjs-overlay.css`. Mounts `<RecoveryBoot/>` first in `<body>`. `<html suppressHydrationWarning>` (the bootstrap mutates `data-theme`). `metadata.title = 'sheet-llm'`. |
| `src/app/page.tsx` | Trivial server component returning `<HomeClient/>`. |
| `src/components/HomeClient.tsx` | `'use client'` composition for `/`. Calls 8 store/sync hooks — `useChatIdSession`, `useReduceMotionSync`, `useFollowPlaybackSync`, `useEditorPrefsSync`, `useTranscriptSync`, `useChatHistoryShortcut`, `useEditPersistence`, `useAuthSync` (account hydration) — then renders `SessionSidebar`, `AppHeader`, `Hero`, `ChatHistoryPanel`, `DebugPanel`, `AuthModal`. Recovery wiring is intentionally NOT here (moved to `RecoveryBoot`). |
| `src/components/Hero.tsx` | Main editor surface. `exportScore = editedScore ?? scoreJson`; `displayedAbc = pendingProposal?.abc ?? abc` (ghost-preview swaps the *rendered* ABC to the candidate while `ExportBar` keeps `abc` + `scoreJson.title` at the pre-proposal state). Hosts `ScoreStage`, `ExportBar`, `PromptBar`, the ⌘K palette (`useCommandPalette`), and the orchestrator overlays (`ReplacementConfirmModal`, ghost-preview overlay/panel, resume toast). Almost all sub-UI gated on `abc` being present. |
| `src/components/AppHeader.tsx` | Server component. Static composition of `SessionsButton`, brand `h1`, and a right cluster: `ChatHistoryButton`, `ImportScoreButton`, `BlankScoreButton`, `NewScoreButton`, `HelpButton`, `ThemeToggle`, `AuthNavButton`. No state of its own. `AuthNavButton` is the only stateful child — it renders nothing until `useAuthSync` resolves, hides when accounts are disabled, and otherwise shows Log in / Sign up (anon) or the account email / Log out (authed). |
| `src/components/ScoreStage.tsx` | Render host. Props `{abc, pending, lastPrompt}`. Crossfades incoming/outgoing `ScorePanel` layers ONLY when chat-store `epoch` advances (fresh LLM response) — **not** on `abc` change (local edits re-render in place). Clears the published abcjs `visualObj` when `abc` empties, drives reveal animation (gated by `debugStore.revealAnimationEnabled`), shows `BlankStaff`/`ComposingStaff` substrates, mounts `TransportHost` when `abc` present. `role="region" aria-live="polite"`. While a sectional generation streams in (chat-store `streamProgress !== undefined`) the `ScorePanel` renders **read-only** — `clickListener`/`interactive`/`reveal` are suppressed so an in-flight section can't clobber a manual edit; editing unlocks on the terminal `done` frame (which clears `streamProgress`). |
| `src/components/RecoveryBoot.tsx` | Mounted in root layout. At **module-import time** (`typeof window !== 'undefined'`) calls `installBackupInterceptor()` so every `fetch` — including the first one before React mounts — captures the recovery header into localStorage. On mount runs `bootRestoreIfNeeded()`. Moved up from `HomeClient` so `/settings` also gets recovery wiring. |
| `src/app/settings/page.tsx` | `/settings` route. `metadata.robots = {index:false, follow:false}`. Renders `<SettingsContent/>`. |
| `src/app/settings/SettingsContent.tsx` | `'use client'` account + GDPR UI. Mounts `<AccountSettings/>` (change password/email, active sessions, log out everywhere) at the top — driven by the accounts milestone; calls `refreshSession()` on mount to hydrate auth state + obtain a CSRF token. Below it: "Download JSON" `<a href="/api/me/export" download rel="nofollow">`; a typed-`DELETE`-gated button that `DELETE`s `/api/me/delete` and on success calls `clearBackup()` + removes every localStorage key the server returns in `clearLocalStorage`. Renders a deletion receipt (`deletedSessions`/`deletedMessages`/`deletedVersions` plus the account counts `deletedAuthSessions`/`deletedOauthAccounts`/`deletedAuthTokens`, shown only when non-zero). |
| `src/app/help/page.tsx` → `src/app/help/HelpContent.tsx` | `/help` route. Public (indexable) user guide. `page.tsx` exports `metadata` (title/description, no robots block); `HelpContent.tsx` is `'use client'` and renders `HELP_SECTIONS` (from `src/lib/help/content.ts`; prose in `src/lib/help/sections.json`) via `react-markdown` + `remark-gfm` with a sticky section nav. The `HelpButton` in `AppHeader` opens a quick-start modal (`HelpModal`) that links here. |
| `src/instrumentation.ts` | `register()` (Next startup hook). Guards on `NEXT_RUNTIME==='nodejs'`, then `ensureMigrationsApplied()` (synchronous, NOT wrapped — a migration failure surfaces at boot) and `reapStalePartials()` (wrapped in try/catch so a WAL-locked DB at boot never crashes the server). |
| `src/app/api/chat/route.ts` | The route kernel. POST (orchestrator/legacy dispatch + SSE converse streaming + SSE score-stream for sectional generation), GET (panel transcript + head-score hydration + version chain), DELETE (idempotent reset). Exports the shared `checkSameOrigin`, `errorResponse`, `UuidSchema`, `synthToolUseId`, `forkSeedToolUseId`. |
| `src/lib/auth/session.ts` | Identity. `getRequestUser()` is THE route-handler entry point → `RequestUser {userId, authenticated, recoveryToken?}`: a valid DB-backed `sl_sess` wins as an authenticated account, else a valid `sl_uid` for an *unclaimed* anon user, else it mints a fresh anon identity (a stale `sl_uid` pointing at a *claimed* account is REFUSED, not honored — `sl_uid` is an unrevocable 1-year bearer JWT). `getExistingRequestUser()` is the never-mint counterpart for `/me/{export,delete}`. The legacy `getOrCreateUserId`/`getExistingUserId` remain but are `@internal` (anon-mint + tests only) — `tests/unit/auth/identityResolverGuard.test.ts` bans them from `src/` outside this file. `COOKIE_NAME='sl_uid'` (httpOnly HS256 JWT) + `sl_present` sentinel (non-httpOnly). Secure unless `SL_INSECURE_COOKIE_OK=1`. `SESSION_SECRET` must be ≥32 bytes. Auth-session minting/verifying/revoking lives in `src/lib/auth/sessionStore.ts` (`verifyAuthSession`, `clearAuthSessionCookies`). |
| `src/lib/auth/attachRecovery.ts` | `attachRecoveryHeader(response, session)` sets `X-Session-Recovery` when `session.recoveryToken` is present; no-op otherwise. Wraps nearly every API response. |
| `src/lib/orchestrator/flags.ts` | Per-request env-flag resolver (no module caching). `getOrchestratorMode()` (default `'primary'`), `isGhostPreviewEnabled()` (default ON), `isReplacementGateEnabled()` (default ON), `isNewToolDispatchEnabled()` (default ON), `isSectionalGenEnabled()` (env `SL_SECTIONAL_GEN`, default ON — routes fresh `generate_complex` through sectional streaming). |

## Core concepts / data flow

### The three-route, no-middleware shape

App Router has three pages (`/`, `/settings`, `/help`). Everything else under `src/app` is an
`api/**/route.ts` handler. There is no `middleware.ts`; each handler that
needs it calls `checkSameOrigin(request)` itself and wraps its response in
`attachRecoveryHeader(...)`. Identity is resolved per-handler via
`getRequestUser()` (or `getExistingRequestUser()` for the GDPR routes). The
accounts milestone added a separate family of mutating `src/app/api/auth/*`
routes (signup/login/logout/OAuth/email/settings) gated behind
`guardAuthMutation` + `SL_ACCOUNTS_ENABLED`; those are owned by the auth-gdpr
subsystem, not this shell doc.

### `chat/route.ts` is the shared kernel

These eleven routes import their CSRF check, error helper, UUID schema,
and/or tool-use-id minters from `src/app/api/chat/route.ts`:
`auth/restore`, `import`, `sessions`, `sessions/[id]`,
`sessions/[id]/versions`, `sessions/[id]/versions/batch`, `chat/fork`,
`chat/revert`, `chat/confirm-replacement`, `me/export`, `me/delete`. A
change to `errorResponse`'s signature or the `ChatErrorCode` set ripples
across all of them.

### POST /api/chat request flow

```
checkSameOrigin (Origin vs Host)                 -> 403 on mismatch
content-length cap (1 MB) + body.length cap      -> 413
JSON.parse + ChatRequestSchema (Zod)             -> 400
   (incl. optional targetRegion {start,endMeasureIdx} — the D5
    deterministic measure-range hint from the right-click AI entries)
getRequestUser()  (auth sl_sess | anon sl_uid;   )
                  (BEFORE the response stream opens)
maybeReapStalePartials()  (throttled microtask)
resolve/create chatId (hasConversation | create) -> 410 chat_not_found
countUserTextTurns >= 20 (answered turns only)   -> 410 chat_full
validateEditedScoreOrError (ScoreSchema-only)    -> 400 invalid_request
checkScoreVersion (hash mismatch)                 -> 409 stale_score
appendMessages([userTurn])  <<< persist user turn IMMEDIATELY (chat-vanish safety)
resolveGenerationTier(userId, debug?.generationTier)  (paywall tier; the
   client-supplied debug.generationTier is IGNORED in prod unless
   SL_ALLOW_TIER_OVERRIDE — see generationTier.ts:isTierOverrideAllowed)
run orchestrator (mode primary | shadow | off; debug overrides win)
  primary + result        -> respondWithOrchestratorResult
  primary + converse      -> respondWithConverseStream (SSE)
  primary + scoreStream   -> respondWithScoreStream (SSE; X-Stream-Kind: score)
  primary + refused       -> 422 refused
  primary + OutputTruncatedError -> 422 output_too_large
  primary + fellThrough \
  shadow / off           } -> legacy completeWithRetry path
scoreToAbc + validateAbc  (assistant write gated on render success) -> 422
appendMessages([assistantTurn])  (score_versions row + head bump inside)
return ChatResponse { chatId, abc, introText, scoreJson, toolUseId, headVersionId, debug, ... }
                     (every response wrapped in attachRecoveryHeader)
```

The user turn is persisted **before** the LLM call so an in-flight
follow-up that dies (LLM error, abort, tab close, recovery reload) still
reappears on hydration. On retry, `prepareMessagesForLLM` collapses
consecutive user turns to the most recent, so the freshest edited-score
wins and orphaned attempts drop out of the LLM-visible history.

### Orchestrator mode resolution (per request)

```
debug.orchestrator override ('on'|'off'|'shadow')  highest
  else getOrchestratorMode():
    ORCHESTRATOR_KILL=1                       -> 'off'
    ORCHESTRATOR_ENABLED in {false,0}         -> 'off'
    ORCHESTRATOR_MODE=shadow                  -> 'shadow'
    default                                   -> 'primary'
```

`primary` — orchestrator wins when it returns a result; a refusal is a
422. `shadow` — orchestrator runs alongside legacy, **legacy wins the
response**, divergence is logged via `logShadowDivergence`. `off` —
orchestrator does not run.

### Score-versions chain + CAS head pointer

Each session has a `head_version_id` pointing into an append-only
`score_versions` DAG (`parent_version_id`, `source` in
`llm|edit|import|fork-seed|revert`). Manual editor edits POST to
`/api/sessions/:id/versions` (`src/app/api/sessions/[id]/versions/route.ts`)
with a **mandatory** `parentVersionId` CAS token + `idempotencyKey`;
mismatches return `409 {code:'stale_parent', currentHead}`. The CAS is
enforced three ways: a JS pre-check, a re-read inside the transaction, and
a SQL-level `WHERE head = parent` (with `isNull()` for the
newly-created-session `parentVersionId === null` case). That route runs
full **semantic** `validateScore` (the chat POST's `editedScore` check is
**schema-only** — mid-edit measures that don't sum to the meter are
allowed so the user can ask the LLM to repair them).

> Note: the versions-write `source` enum is `['llm','edit','import','fork-seed']`
> — `revert` rows are NOT written through this route; they are minted by
> `chat/confirm-replacement` and `chat/revert`.

### Confirmation / ghost-preview gate defers the head bump

When the orchestrator sets `requiresConfirmation` (replacement gate OR
ghost preview), `respondWithOrchestratorResult` persists the candidate
`score_versions` row but passes `skipHeadVersionBump:true`, so the
candidate hangs off the prior head as an orphan and `head_version_id`
still points at the prior version. The response carries either
`replacement` (with `retainedIdentityRatio`, `reasons`,
`candidateVersionId`) or `proposal` (with `affectedEventIds`,
`candidateVersionId`). `/api/chat/confirm-replacement` later resolves it:

| decision | effect |
| --- | --- |
| `accept` | advance `head_version_id` to the candidate |
| `dont_ask_again_this_session` | accept + set `sessions.replacement_gate_suppressed=1` |
| `reject` | write a `revert` `score_versions` row chained to the prior head; head → revert row (candidate stays orphaned) |

### Recovery-token round-trip

Anonymous identity survives cookie loss via a **separate** recovery JWT
(`RECOVERY_SECRET`, distinct from `SESSION_SECRET`, so an exfiltrated
recovery token can't forge a session cookie).

```
server: getRequestUser() mints an anon session -> recoveryToken set on RequestUser
        attachRecoveryHeader stamps  X-Session-Recovery  on the response
client: installBackupInterceptor() (RecoveryBoot module-load) reads the
        header into localStorage['sheet-llm:recovery']
client: bootRestoreIfNeeded() — if no sl_present cookie, POST /api/auth/restore
server: verifyRecoveryToken -> single-use nonce CAS on users.last_recovery_nonce
        (409 on replay) -> reissueSessionForRecovery re-mints the sl_uid cookie
        + a fresh rolling recovery token
```

`recoveryToken` on the returned `RequestUser` is populated ONLY when a fresh
anonymous cookie was minted (new anon user, invalid `sl_uid`, GC'd-user retry,
or a refused stale `sl_uid` that pointed at a claimed account); the normal
returning-anon path and EVERY authenticated (`sl_sess`) request leave it
undefined and `attachRecoveryHeader` is a no-op (logged-in accounts don't get
a localStorage recovery token).

### Boot-time migration + janitor

`register()` (`src/instrumentation.ts`) runs once per nodejs server
process: `ensureMigrationsApplied()` synchronously (so routes never see a
stale schema), then `reapStalePartials()` to clean up `partial` streaming
rows left by prior crashes. A throttled in-request `maybeReapStalePartials()`
in chat POST avoids needing a cron.

### Converse SSE

`respondWithConverseStream` inserts a `partial` assistant row **before**
opening the stream (so concurrent writers pick a higher seq, and a
mid-stream crash leaves a reapable row rather than a vanished turn), then
pumps `event: header` / `text-delta` / `done` / `error` frames with a
`: keepalive` comment every ~15 s. It finalizes the row `complete` on
`message-stop`, `errored` (`client_abort`) on `cancel()`.

## Invariants & gotchas

- **`chat/route.ts` is a load-bearing import hub.** Eleven routes re-import
  `checkSameOrigin` / `errorResponse` / `UuidSchema` / `synthToolUseId` /
  `forkSeedToolUseId`. Changing `errorResponse`'s signature or the
  `ChatErrorCode` set touches all of them.
- **`getRequestUser` claim-gates `sl_uid`.** A `sl_uid` JWT is an
  unrevocable 1-year bearer token; once an account is *claimed*
  (email/password/OAuth), honoring a stale `sl_uid` for it would be a
  passwordless login, so `getRequestUser`/`getExistingRequestUser` REFUSE it
  (anon path mints fresh; export/delete return null/401). A DB-backed
  `sl_sess` (revocable, from `sessionStore.ts`) authenticates claimed
  accounts. Only the legacy `getOrCreateUserId`/`getExistingUserId` are
  un-gated, which is exactly why an `identityResolverGuard` test keeps them
  out of route code.
- **Synthetic `toolu_orch_*` ids are NOT valid Anthropic anchors.**
  `findLastToolUseId` skips them and `prepareMessagesForLLM` drops the
  synth assistant turn *plus its preceding user turn*. The JSDoc on
  `respondWithOrchestratorResult` flags a Phase-1 TODO: if a
  `toolu_orch_*` head is later refined on the legacy path, Anthropic will
  reject the dangling `tool_result`. **`fork-seed` ids (`toolu_fork_*`)
  deliberately use a different prefix** because they MUST survive as real
  refinement anchors.
- **Head-bump is conditional.** `requiresConfirmation` persists the
  candidate row WITHOUT advancing `head_version_id`. Hydration and the
  client freshness check both key off `head_version_id`, not the latest
  row — forgetting the head still points at the prior version is the easy
  bug.
- **Ghost preview and the replacement gate are mutually exclusive per
  turn; the replacement gate wins** (it has the
  `dont_ask_again_this_session` affordance the proposal flow lacks). Both
  are default-ON, read per-request (`SL_GHOST_PREVIEW`,
  `SL_REPLACEMENT_GATE`).
- **`getExistingRequestUser()` (never-mint) MUST be used by `/api/me/export`
  and `/api/me/delete`.** Using `getRequestUser()` there mints a
  phantom anon account and silently export-empties / deletes-nothing while
  the real account sits unreachable — a GDPR Art. 17 footgun explicitly
  called out in both routes (they 401 when it returns null). `me/delete`
  additionally calls `clearAuthSessionCookies()` (a claimed account deleting
  itself) and reports the account-table receipt counts.
- **`editedScore` validation in chat POST is schema-only** (not semantic);
  `/api/sessions/:id/versions` and `.../batch` run full `validateScore`.
- **Same-origin is enforced only when BOTH Origin and Host are present**
  (server-to-server / curl with no Origin passes). It is a CSRF
  mitigation, not authentication; the cookie scope is the real authz
  boundary.
- **The theme bootstrap runs before React/hydration.** `<html>` carries
  `suppressHydrationWarning` specifically because the inline script mutates
  `data-theme`.
- **`register()` swallows a janitor failure but NOT a migration failure**
  (the latter surfaces at startup). Guarded by `NEXT_RUNTIME==='nodejs'`,
  so it no-ops on edge/other runtimes.
- **`ScoreStage` crossfades on `epoch` change, not `abc` change.** Local
  edits mutate `abc` without bumping `epoch`, so they re-render in place. A
  code path that mutates the score but forgets to advance `epoch` shows no
  crossfade; a stray `epoch` bump fades on a no-op edit.
- **`getRequestUser()` must run before the response stream opens.**
  Next 16 forbids `cookies().set` after flush — that's why chat POST
  resolves the session up front, before the orchestrator/SSE call. (Same
  constraint for the legacy `getOrCreateUserId` it replaced.)

## How to extend / common tasks

- **Add a new `/api/**` route.** Start by importing `checkSameOrigin` +
  `errorResponse` from `@/app/api/chat/route`, run the same-origin check
  first, cap `content-length`, parse the body with a Zod schema, resolve
  identity with `getRequestUser()` (or `getExistingRequestUser()` for
  user-data reads/deletes), and wrap the final response in
  `attachRecoveryHeader(res, session)`. Set `runtime = 'nodejs'`. Do NOT
  reach for `getOrCreateUserId`/`getExistingUserId` — they're `@internal`
  and an `identityResolverGuard` unit test fails the build if they appear
  in `src/` outside `session.ts`.
- **Add a new chat error code.** Extend `ChatErrorCode` in
  `src/lib/shared/types.ts`; every consumer of `errorResponse` accepts it
  automatically.
- **Add a new env flag for the orchestrator.** Put the getter in
  `src/lib/orchestrator/flags.ts` using `readBool` / `readExplicitFalse`
  so it stays per-request (no module caching) — operators must be able to
  flip without redeploy.
- **Add another top-level page** (beyond `/`, `/settings`, `/help`). Mind
  that recovery wiring lives in `RecoveryBoot` (mounted at the layout level)
  so any new route already gets the interceptor — do NOT re-add it to a page
  component.
- **Add a new score-mutation path.** If it should trigger the editor
  crossfade, bump the chat-store `epoch`. If it persists a new score, go
  through the `score_versions` CAS write (`/api/sessions/:id/versions`),
  never a bare head update.

## Testing

Route coverage lives under `tests/integration/` (no co-located `src/app`
tests):

- `tests/integration/api-chat.test.ts`,
  `api-chat-transcript.test.ts`, `api-chat-fork.test.ts`,
  `api-chat-versions-chain.test.ts`, `api-chat-synth-id.test.ts`,
  `api-chat-orchestrator-phase0.test.ts`
- `tests/integration/api-sessions.test.ts`,
  `api-sessions-id.test.ts`, `api-sessions-versions.test.ts`
- `tests/integration/api-import.test.ts`, `api-import-blank.test.ts`
- `tests/integration/api-me-gdpr.test.ts`
- `tests/integration/auth/restore.test.ts`, `auth/session.test.ts`,
  `auth/sessionResolver.test.ts` (the `getRequestUser` claim-gating contract)
- `tests/unit/db/janitor.test.ts`, `db/streamingLifecycle.test.ts`
- `tests/unit/auth/clientBackup.test.ts`, `auth/recovery.test.ts`,
  `auth/restoreRateLimit.test.ts`,
  `auth/identityResolverGuard.test.ts` (bans legacy `getOrCreateUserId`/`getExistingUserId` from route code)
- `tests/unit/orchestrator/generationTier.test.ts` — the paywall-tier
  resolution + `SL_ALLOW_TIER_OVERRIDE` guard threaded through chat POST.

## Related files / See also

- `src/lib/orchestrator/README.md` — the dispatch/verify/gate architecture
  behind `respondWithOrchestratorResult`.
- `src/lib/auth/recovery.ts` — `RECOVERY_HEADER`, `RECOVERY_STORAGE_KEY`,
  token sign/verify + nonce.
- `src/lib/auth/clientBackup.ts` — `installBackupInterceptor`,
  `bootRestoreIfNeeded`, `clearBackup`.
- `src/app/api/auth/restore/route.ts` — single-use nonce CAS, cookie
  re-issue.
- `src/lib/llm/conversations.ts` — `appendMessages`,
  `appendStreamingAssistant`, `finalizeStreamingMessage`,
  `skipHeadVersionBump`.
- `src/lib/db/janitor.ts` / `src/lib/db/maybeReap.ts` — stale-`partial`
  reaping.
- `src/lib/shared/types.ts` — `ChatErrorCode`, `ChatResponse`,
  `TranscriptResponse`, `ConfirmReplacementResponse`.
