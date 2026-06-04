---
title: API Routes Reference
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/app/api/chat/route.ts
  - src/app/api/chat/confirm-replacement/route.ts
  - src/app/api/chat/fork/route.ts
  - src/app/api/chat/revert/route.ts
  - src/app/api/import/route.ts
  - src/app/api/sessions/route.ts
  - src/app/api/sessions/[id]/route.ts
  - src/app/api/sessions/[id]/versions/route.ts
  - src/app/api/sessions/[id]/versions/batch/route.ts
  - src/app/api/auth/restore/route.ts
  - src/app/api/auth/signup/route.ts
  - src/app/api/auth/login/route.ts
  - src/app/api/auth/logout/route.ts
  - src/app/api/auth/logout-all/route.ts
  - src/app/api/auth/session/route.ts
  - src/app/api/auth/forgot/route.ts
  - src/app/api/auth/reset/route.ts
  - src/app/api/auth/verify-email/route.ts
  - src/app/api/auth/verify-email/send/route.ts
  - src/app/api/auth/change-password/route.ts
  - src/app/api/auth/change-email/route.ts
  - src/app/api/auth/sessions/route.ts
  - src/app/api/auth/sessions/revoke/route.ts
  - src/app/api/auth/oauth/[provider]/start/route.ts
  - src/app/api/auth/oauth/[provider]/callback/route.ts
  - src/app/api/me/delete/route.ts
  - src/app/api/me/export/route.ts
  - src/lib/shared/types.ts
  - src/lib/auth/session.ts
  - src/lib/auth/routeGuard.ts
  - src/lib/auth/attachRecovery.ts
related:
  - orchestrator
  - persistence-db
  - auth-gdpr
  - import
  - ghost-preview
  - chat-session
---

# API Routes Reference

A complete inventory of every HTTP route handler under `src/app/api/**/route.ts`
at this commit. 27 `route.ts` files, exporting one or more HTTP method handlers
each. They split into two families with **different** shared guard stacks: the
original score/session/GDPR routes (`/api/chat*`, `/api/sessions*`, `/api/import`,
`/api/me/*`) and the email/OAuth **accounts** routes under `/api/auth/**`
(everything except `/api/auth/restore`, which predates accounts and rides the
score-route conventions).

This is a reference, not a tutorial. For the *why* behind a given route's
behavior, follow the cross-links: the `/api/chat` orchestrator branch is
documented in [`orchestrator.md`](../subsystems/orchestrator.md); the
score-version chain and CAS model in
[`persistence-db.md`](../subsystems/persistence-db.md); the recovery / accounts
flows in [`auth-gdpr.md`](../subsystems/auth-gdpr.md).

## Conventions shared by every route

These are not boilerplate — they are invariants enforced by shared helpers
that the route files import. Verify them once here instead of repeating them
per route.

These apply to the **score/session/GDPR** family. The `/api/auth/**` accounts
routes use a parallel-but-stricter stack — see [Accounts route
conventions](#accounts-route-conventions) below.

| Concern | Mechanism | Source |
| --- | --- | --- |
| Runtime | Every route sets `export const runtime = 'nodejs'` (better-sqlite3 + `jose` need Node, not Edge). | each `route.ts` |
| Same-origin gate | `checkSameOrigin(request)` rejects requests whose `Origin` host ≠ `Host`. Missing `Origin` (same-origin GETs, server-to-server) passes. | `src/app/api/chat/route.ts:checkSameOrigin` |
| Error envelope | `errorResponse(code, status, error, chatId?)` → `{ code, error, chatId? }`. `code` is a `ChatErrorCode`. | `src/app/api/chat/route.ts:errorResponse` |
| Identity (mutating) | **`getRequestUser()`** resolves the request identity: a valid DB-backed `sl_sess` → the authenticated account; else a valid `sl_uid` for an **anonymous (unclaimed)** user → that anon id; else (no/invalid `sl_uid`, a GC'd user, **or** an `sl_uid` pointing at a *claimed* account) → **mints a fresh anonymous identity**. Returns `{ userId, authenticated, recoveryToken? }`. (Replaces the old `getOrCreateUserId`, which is now an `@internal` primitive banned from route code.) | `src/lib/auth/session.ts:getRequestUser` |
| Identity (GDPR) | **`getExistingRequestUser()`** is the get-only variant — returns `null` instead of minting (also `null` for an `sl_uid` that points at a claimed account → "must log in"). Used by `/me/*` so a cookie-less caller can't create-then-act on a phantom account. (Replaces `getExistingUserId`.) | `src/lib/auth/session.ts:getExistingRequestUser` |
| Recovery header | Most success responses are wrapped in `attachRecoveryHeader(res, session)`, which sets `X-Session-Recovery` when a **fresh anonymous identity was just minted** (`recoveryToken` is populated only then — never for an authenticated request, suppressing the recovery machinery for logged-in accounts). | `src/lib/auth/attachRecovery.ts:attachRecoveryHeader` |
| Body size | Each mutating route reads `content-length`, rejects oversize with **413** before reading the body, then re-checks the decoded length (the header is advisory). | per route (`MAX_BODY_BYTES`) |

**Auth model.** As of the accounts milestone there **is** login: an anonymous
identity can be claimed into an email+password (or OAuth) account via
`/api/auth/**` (below). For the score/session/GDPR routes, identity is still
resolved by `getRequestUser()` and may be either an authenticated account
(`authenticated: true`) or an anonymous cookie-backed user. "Auth requirement"
below therefore means *which resolver runs* and whether ownership scoping
applies — these routes do not themselves require a *logged-in* account.
Cross-user isolation is enforced by scoping every DB query to the resolved
`userId` (sessions the caller doesn't own return 404, never another user's
data). Crucially, a stale `sl_uid` for a **claimed** account is refused (not
authenticated): `sl_uid` is an unrevocable 1-year bearer JWT, so honoring it
would be a passwordless login — `getRequestUser` mints a clean anon instead and
the user must sign in.

`ChatErrorCode` values (`src/lib/shared/types.ts`):
`invalid_request | chat_not_found | chat_full | rate_limited | upstream_error |
validation_failed | refused | internal_error | stale_score | import_failed |
output_too_large | deadline_exceeded | account_claimed`. (`account_claimed` is
new with accounts — see `/api/auth/restore`.)

---

## `/api/chat` — `POST`, `GET`, `DELETE`

`src/app/api/chat/route.ts`. The orchestrator entry point and the most complex
route in the app. `export const maxDuration = 300`. Also exports shared
utilities every other chat route imports: `errorResponse`, `checkSameOrigin`,
`UuidSchema`, `synthToolUseId`, `forkSeedToolUseId`.

### `POST /api/chat`

Submit a prompt against a (new or existing) chat session and get back a
rendered Score.

- **Auth:** `getRequestUser()` (mints anon if needed). Same-origin gated.
- **Body** (`ChatRequestSchema`, max 1 MB):
  ```ts
  {
    chatId?: string (uuid),        // omit → a new conversation is created
    message: string (1..2000),
    targetRegion?: {               // deterministic measure-range hint (D5);
      startMeasureIdx: number,     //   set by right-click "edit with AI" on a
      endMeasureIdx: number,       //   selected bar/range. 0-based, inclusive.
    },                             //   Threaded to the tool dispatcher.
    editedScore?: Score,           // user's manual edits since last turn
    score_version?: string (1..64),// optional freshness hash (scoreHash of
                                   //   the score the client believes is head)
    debug?: {                      // debug-panel overrides
      orchestrator?: 'on'|'off'|'shadow',
      modelOverride?: string,
      apiKey?: string,
    }
  }
  ```
- **Flow.** Resolve/create `chatId` → load transcript → enforce the
  `MAX_USER_TURNS = 20` text-turn cap (counted on *answered* turns only;
  failed/retried turns do not consume quota) → validate `editedScore` (schema-only)
  → optional `score_version` freshness check → **persist the user turn
  immediately** (orphan-survives-failure; collapsed on retry by
  `prepareMessagesForLLM`) → run the orchestrator (mode `primary`/`shadow`/
  `off`, env-gated by `getOrchestratorMode`, overridable via `debug`).
  In `primary` mode an orchestrator result short-circuits the legacy LLM
  path; otherwise the legacy `completeWithRetry` path runs. The result is
  transpiled to ABC (`scoreToAbc` + `validateAbc`) **before** the assistant
  turn is persisted, so a render failure never leaves a bad turn in the DB.
- **Response (200, JSON `ChatResponse`):**
  ```ts
  { chatId, abc, introText, scoreJson: Score, toolUseId,
    headVersionId?, debug, requiresConfirmation?, replacement?, proposal? }
  ```
  - `requiresConfirmation: true` + `replacement: { retainedIdentityRatio,
    reasons, candidateVersionId }` — the replacement-as-confirmation gate
    fired (a wholesale rewrite the user didn't explicitly ask for). The
    candidate score-version row is persisted but `sessions.head_version_id`
    is **not** advanced; the client must POST the decision to
    `/api/chat/confirm-replacement`. See
    [`orchestrator.md`](../subsystems/orchestrator.md).
  - `requiresConfirmation: true` + `proposal: { affectedEventIds,
    candidateVersionId }` — the M24 AI ghost-preview path. Same head-skip
    gate, different payload; resolved the same way via confirm-replacement.
    See [`ghost-preview.md`](../subsystems/ghost-preview.md).
  - Header `X-Orchestrator-Label: <classification.kind>` on orchestrator
    results.
- **Streaming variants.** Two SSE response modes exist (header
  `Content-Type: text/event-stream`):
  - **Converse stream** — when the orchestrator classifies the turn as
    `converse`. Frames: `event: header`, `event: text-delta`, `event: done`,
    `event: error`, plus `: keepalive` comments every ~15 s. A `partial`
    assistant row is written before the stream opens so a mid-stream crash is
    reapable (`finalizeStreamingMessage`), and client-abort finalizes the row
    as `errored`/`client_abort`.
  - **Score stream** — when `generate_complex` (no `editedScore`) routes to
    `runGenerateSectionalStream` (enabled by default; see `SL_SECTIONAL_GEN`).
    Header `X-Stream-Kind: score`. Frames: `event: section` (carries a
    cumulative `Score` after each generated section), `event: done` (final
    assembled score), `event: error`. The final score is persisted on
    `done`; sections received before `done` are progressive renders only.
- **Status codes:**

  | Status | Code | Cause |
  | --- | --- | --- |
  | 200 | — | Success (JSON or SSE). |
  | 400 | `invalid_request` | Unreadable / unparseable body, malformed `editedScore`. |
  | 403 | `invalid_request` | Cross-origin request. |
  | 409 | `stale_score` | `score_version` doesn't match the server's last assistant score. |
  | 410 | `chat_not_found` | `chatId` unknown / deleted (raced DELETE). |
  | 410 | `chat_full` | 20-turn cap reached. |
  | 413 | `invalid_request` | Body > 1 MB. |
  | 422 | `refused` | Orchestrator refused (copyright filter, etc.) — `error` carries the reason. |
  | 422 | `output_too_large` | LLM response hit `max_tokens` before producing a complete score (`OutputTruncatedError`). |
  | 422 | `validation_failed` | Score failed `validateScore` / `validateAbc` after retries. |
  | 502 | `upstream_error` | LLM call failed (or upstream 500 remapped). |
  | 503 | `rate_limited` | Provider rate-limited. |
  | 503 | `deadline_exceeded` | Orchestrator hit the per-request deadline; the route returns a clean error instead of falling through to the unbounded legacy path (M26). |
  | 500 | `internal_error` | Unexpected orchestrator throw (non-shadow mode). |

  Errors fired *after* `chatId` resolution include `chatId` in the body so
  the client can retry against the same orphan-bearing session.

### `GET /api/chat?chatId=<uuid>`

Hydrate the panel-facing transcript for a chat (used on refresh /
session-switch).

- **Auth:** `getRequestUser()`. Same-origin gated.
- **Query:** `chatId` (uuid, required).
- **Response (200, JSON `TranscriptResponse`):** `{ chatId, turns:
  TranscriptTurn[], currentScore?, currentAbc?, currentToolUseId?,
  currentIntroText?, headVersionId?, versions? }`. The head score is resolved
  preferring `score_versions[head_version_id]` (reflects persisted manual
  edits) over a transcript scan; `versions[]` is the parent-chain walk
  (recursive CTE, capped at 50, oldest→head) so the client gets undo history
  in one round-trip.
- **Status codes:** 400 `invalid_request` (missing/invalid `chatId`); 404
  `chat_not_found` (note: GET uses **404**, not the POST's 410 — it's a
  read, REST convention).

### `DELETE /api/chat?chatId=<uuid>`

Reset/clear a conversation server-side.

- **Auth:** `getRequestUser()`. (No explicit same-origin gate in this
  handler.) Scoped to `session.userId` inside `deleteConversation`.
- **Response:** **204**, idempotent — returns 204 even when `chatId` is
  unknown.
- **Status codes:** 400 `invalid_request` (missing/invalid `chatId`); 204
  otherwise.

---

## `/api/chat/confirm-replacement` — `POST`

`src/app/api/chat/confirm-replacement/route.ts`. Resolves a turn that
`/api/chat` flagged `requiresConfirmation` (replacement gate **or** ghost
preview — both use the same candidate-row mechanism).

- **Auth:** `getRequestUser()`. Same-origin gated. Ownership checked via
  `hasConversation(userId, chatId)` and the candidate row's `sessionId`.
- **Body** (max 2 KB): `{ chatId: uuid, candidateVersionId: uuid, decision:
  'accept' | 'reject' | 'dont_ask_again_this_session' }`.
- **Decisions:**
  - `accept` — advance `sessions.head_version_id` to the candidate.
  - `dont_ask_again_this_session` — accept **and** set
    `sessions.replacement_gate_suppressed = 1` so the orchestrator skips the
    gate for the rest of the session.
  - `reject` — write a new `revert`-source `score_versions` row pointing at
    the prior head (re-asserting the prior score as current); the candidate
    stays in the DB as an orphan branch.
- **Response (200, JSON `ConfirmReplacementResponse`):** `{ chatId,
  headVersionId, replacementGateSuppressed }`. On accept, `headVersionId` is
  the candidate; on reject, it's the freshly-written revert row's id.
- **Status codes:** 400 `invalid_request` (bad body); 403 `invalid_request`
  (cross-origin); 404 `chat_not_found` (unknown chat / candidate not in
  session); 409 `invalid_request` (reject with no prior head — inconsistent
  state); 413 `invalid_request` (> 2 KB); 500 `internal_error` (prior-head
  row missing/malformed on reject).

---

## `/api/chat/fork` — `POST`

`src/app/api/chat/fork/route.ts`. Fork a chat: create a **fresh** chatId
seeded with a single synthetic assistant turn carrying a chosen historical
score. The original chat is untouched.

- **Auth:** `getRequestUser()`. Same-origin gated. Ownership via
  `hasConversation(userId, fromChatId)`.
- **Body** (max 1 KB): `{ fromChatId: uuid, toolUseId: string (1..128) }`.
- **Flow.** Locate the `tool_use` block by id in the source transcript →
  re-`validateScore` + `scoreToAbc`/`validateAbc` (defensive: legacy/corrupt
  scores must not poison the fork) → `createConversation` with
  `forkedFromSessionId` / `forkedFromVersionId` set → seed a synthetic
  user+assistant pair (`scoreSource: 'fork-seed'`). The seed tool-use id uses
  the `toolu_fork_*` prefix (`forkSeedToolUseId`) — distinct from
  orchestrator-synthetic `toolu_orch_*` ids because a fork seed **is** a valid
  refinement anchor and must survive `prepareMessagesForLLM`.
- **Response (200, JSON `ForkResponse`):** `{ chatId, abc, scoreJson,
  introText, toolUseId }`.
- **Status codes:** 400 `invalid_request`; 403 `invalid_request`
  (cross-origin); 404 `chat_not_found` (source chat or score-by-toolUseId not
  found); 413 `invalid_request` (> 1 KB); 422 `validation_failed` (stored
  score failed re-validation).

---

## `/api/chat/revert` — `POST`

`src/app/api/chat/revert/route.ts`. In-place revert: append a synthetic
user+assistant pair to the **existing** chat that carries a copy of a chosen
historical score and bumps `head_version_id` to a fresh `revert`-source row.
History is preserved (revert shows as one more tail turn). Contrast with
`/fork`, which branches a new chat.

- **Auth:** `getRequestUser()`. Same-origin gated. Ownership via
  `hasConversation`.
- **Body** (max 1 KB): `{ chatId: uuid, toolUseId: string (1..128) }`.
- **Flow.** Find score by `toolUseId` → re-validate → `appendMessages(...,
  { scoreSource: 'revert' })` (atomic: synthetic turns + new `revert`
  score-version chained to prior head + head bump) → re-read head. The seed
  uses `synthToolUseId()` (`toolu_orch_*`) so `prepareMessagesForLLM` strips
  the pair from LLM-visible history.
- **Response (200, JSON `RevertResponse`):** `{ chatId, abc, scoreJson,
  introText, toolUseId, headVersionId, newTurn }` — `newTurn` is a ready-made
  `render_score` `TranscriptTurn` the client can splice without a refetch.
- **Status codes:** 400 / 403 / 413 as above; 404 `chat_not_found`; 422
  `validation_failed`; 500 `internal_error` (head missing after the bump —
  should be unreachable).

---

## `/api/import` — `POST`

`src/app/api/import/route.ts`. Parse an uploaded score (ABC / MIDI /
uncompressed MusicXML / Score JSON / blank seed) and seed a fresh chat with it.
**Never calls the LLM** — works identically with or without
`ANTHROPIC_API_KEY`. `export const maxDuration = 30`. See
[`import.md`](../subsystems/import.md).

- **Auth:** `getRequestUser()`. Same-origin gated.
- **Two body modes (content-type sniffed):**
  - **`application/json`** (max 1 MB), `JsonImportSchema`: `{ format:
    'abc'|'json'|'musicxml'|'blank', text?, filename?, truncateIfLong?,
    layoutOverride?: 'single'|'grand-staff'|'satb' }`. `text` required unless
    `format === 'blank'` (blank skips the parser and seeds `BLANK_SCORE`).
  - **`multipart/form-data`** (max 2 MB): field `file` (required `File`),
    optional `truncateIfLong` (`'true'`/`'1'`), optional `layoutOverride`.
    Format is auto-detected (`detectFormat`) from filename + MIME + content
    sniff; this is the MIDI-binary and MusicXML-file path.
- **Flow.** Parse → `validateScore` (semantic) → `scoreToAbc` + `validateAbc`
  → `seedConversation` (synthetic user+assistant, `scoreSource: 'import'`,
  `synthToolUseId`).
- **Response (200, JSON `ImportResponse`):** `{ chatId, abc, introText,
  scoreJson, toolUseId, warnings: ImportWarningWire[], importFormat,
  filename? }`. Header `X-Import-Latency-Ms`.
- **Status codes:**
  - 400 `invalid_request` — unreadable body, bad JSON shape, missing/invalid
    `file` field.
  - 403 `invalid_request` — cross-origin.
  - 413 `invalid_request` — body / file over the cap.
  - **422 `import_failed`** — blocking parse problem. Body is
    `ImportErrorResponse` = `{ code: 'import_failed', error, warnings:
    ImportWarningWire[] }`. Covers: compressed `.mxl` MusicXML, undetectable format,
    blocking parser warnings, semantic `validateScore` failure, and
    `validateAbc` failure (each appended to `warnings` with the right
    `severity: 'block'` code).

---

## `/api/sessions` — `GET`, `POST`

`src/app/api/sessions/route.ts`. The sidebar's session list. See
[`persistence-db.md`](../subsystems/persistence-db.md).

### `GET /api/sessions?limit=<n>`

- **Auth:** `getRequestUser()`. Same-origin gated. Scoped to `userId` and
  `deletedAt IS NULL`.
- **Query:** `limit` (default 50, clamped 1..200).
- **Response (200):** `{ sessions: SessionSummary[] }`, most-recently-active
  first. Each summary carries an ~80-char preview snippet from the latest
  user message.

### `POST /api/sessions`

- **Auth:** `getRequestUser()`. Same-origin gated.
- **Body:** none.
- **Response:** **201** `{ session: SessionSummary }` (empty draft, same shape
  as a list row so the client splices it in without a refetch).

---

## `/api/sessions/[id]` — `PATCH`, `DELETE`

`src/app/api/sessions/[id]/route.ts`. Per-session rename / delete. `id` comes
from the dynamic segment (`ctx.params` is a Promise in Next 16).

### `PATCH /api/sessions/[id]` — rename

- **Auth:** `getRequestUser()`. Same-origin gated. Ownership-scoped in the
  UPDATE `WHERE` (id + userId + `deletedAt IS NULL`).
- **Body** (max 4 KB): `{ title: string(≤120) | null }`. Empty/whitespace
  titles normalize to `null` (sidebar falls back to its preview heuristic).
- **Response (200):** `{ session: SessionSummary }` (with recomputed
  `messageCount` + `preview`).
- **Status codes:** 400 `invalid_request` (missing id / bad body); 413
  `invalid_request` (> 4 KB); 404 `chat_not_found` (not found, not owned, or
  soft-deleted — the three are indistinguishable by design).

### `DELETE /api/sessions/[id]` — soft-delete

- **Auth:** `getRequestUser()`. Same-origin gated. `userId` scope enforced
  inside `deleteConversation`.
- **Response:** **204**, idempotent (204 even if absent / already deleted /
  another user's — a 404-vs-204 distinction would leak existence).
- **Status codes:** 400 `invalid_request` (missing id); 204 otherwise.

---

## `/api/sessions/[id]/versions` — `POST`

`src/app/api/sessions/[id]/versions/route.ts`. Persist **one** manual-edit
score checkpoint. The canonical single-write form of the CAS + idempotency
model. See [`persistence-db.md`](../subsystems/persistence-db.md) and
[`chat-session.md`](../subsystems/chat-session.md).

- **Auth:** `getRequestUser()`. Same-origin gated. Ownership checked in
  `writeVersion` (session.userId === userId, not soft-deleted).
- **Body** (`VersionWriteSchema`, max 32 KB):
  ```ts
  {
    parentVersionId: string(1..64) | null,  // CAS token (REQUIRED). null =
                                            //   "I believe head is unset".
    score: Score,
    abc?: string (≤64 KB),
    source: 'llm'|'edit'|'import'|'fork-seed',
    coalesceKey?: string (1..64),
    idempotencyKey: string (1..64),         // REQUIRED, UNIQUE
  }
  ```
- **Concurrency.** `idempotencyKey` is UNIQUE → a replay returns the existing
  row's id (200). `parentVersionId` must equal `sessions.head_version_id`
  (CAS), re-verified **inside** the transaction (JS check + SQL-level
  `isNull`/`eq` predicate) to defeat the read-then-write race.
- **Response:**
  - **201** `{ versionId }` — new row inserted, head advanced.
  - **200** `{ versionId }` — idempotent replay (key already seen).
  - **409** `{ code: 'stale_parent', error, currentHead }` — CAS mismatch;
    client reconciles against `currentHead` and retries.
- **Status codes:** 400 `invalid_request` (bad id / body / `validateScore`
  failure); 403 `invalid_request` (cross-origin); 413 `invalid_request`
  (> 32 KB); 404 `chat_not_found` (not owned / deleted); 200/201/409 as above.

---

## `/api/sessions/[id]/versions/batch` — `POST`

`src/app/api/sessions/[id]/versions/batch/route.ts`. Persist a **chain** of
edit checkpoints in one transaction. Serves the `beforeunload` `sendBeacon`
flush, so the outer envelope cap is generous (16 MB) while each score is
capped at 1 MB.

- **Auth:** `getRequestUser()`. Same-origin gated. Ownership in
  `writeBatch`.
- **Body** (`BatchSchema`, max 16 MB envelope):
  ```ts
  {
    baseParentVersionId: string(1..64) | null,  // CAS base for the chain
    versions: Array<{                            // 1..64 entries
      idempotencyKey: string(1..64),
      score: Score,
      abc?: string (≤64 KB),
      source: 'llm'|'edit'|'import'|'fork-seed',
      coalesceKey?: string (1..64),
    }>
  }
  ```
- **Per-version cap.** Each `score` JSON must be ≤ 1 MB
  (`MAX_SCORE_JSON_BYTES`); over-cap returns **413** with the offending index
  (`versions[i]`) — distinct status from the 400 shape-rejection so the client
  can tell size from shape without parsing the message.
- **Concurrency.** Bulk-resolves previously-seen `idempotencyKey`s (full-batch
  replay short-circuits with the original ids, 200). Builds the parent chain
  inside one transaction; CAS on `baseParentVersionId` re-checked inside the
  transaction; final head = the last entry's resolved id.
- **Response:**
  - **201** `{ versionIds: string[] }` — chain inserted.
  - **200** `{ versionIds }` — every entry was already written (full replay).
  - **409** `{ code: 'stale_parent', error, currentHead }` — CAS mismatch.
- **Status codes:** 400 `invalid_request` (bad id / body / per-version
  `validateScore` with `versions[i]:` prefix); 403 `invalid_request`; 413
  `invalid_request` (envelope or any per-version score over cap); 404
  `chat_not_found`; 200/201/409 as above.

---

## `/api/auth/restore` — `POST`

`src/app/api/auth/restore/route.ts`. Re-issue the session cookie after cookie
loss (Safari ITP, cleared storage, cross-device transfer) from the
localStorage recovery-token backup. `export const dynamic = 'force-dynamic'`.
This is the security-critical recovery path — see
[`auth-gdpr.md`](../subsystems/auth-gdpr.md).

- **Auth:** **No session resolver.** Identity comes from verifying the
  recovery JWT (`verifyRecoveryToken`), which is signed with `RECOVERY_SECRET`
  — a key separate from `SESSION_SECRET`. Same-origin gated.
- **Body** (max 4 KB): `{ token: string (20..4096) }`.
- **Defense ordering (deliberate).** Same-origin → content-length 413 →
  per-IP rate-limit (`checkIp`, **before** any crypto/DB work) → parse →
  `verifyRecoveryToken` → per-sub rate-limit (`checkSub`, **after**
  verification so forged tokens can't poison the sub bucket) → single-use
  compare-and-swap on `users.last_recovery_nonce`.
- **Single-use CAS.** The UPDATE only succeeds when the token's `nonce` differs
  from the last-consumed nonce **and** the row is still anonymous (`email`,
  `password_hash`, `claimed_at` all NULL — folded INTO the CAS predicate so the
  claim refusal is atomic with nonce consumption, no separate-SELECT TOCTOU).
  Zero rows → one disambiguation SELECT distinguishes "user gone" (410, code
  `chat_not_found`) from "now a claimed account" (409, code `account_claimed`)
  from "nonce replayed" (409, code `invalid_request`). Recovery is for
  anonymous identities only: a leaked recovery token must not re-authenticate a
  claimed account.
- **Response:** **204** with header `X-Session-Recovery: <new recovery token>`
  (rolling refresh) and a freshly minted session cookie.
- **Status codes:**

  | Status | Cause |
  | --- | --- |
  | 204 | Cookie re-issued; new recovery token in `X-Session-Recovery`. |
  | 400 | Malformed body. |
  | 401 | Bad / expired / malformed recovery token. |
  | 409 `invalid_request` | Token replayed (nonce already consumed). |
  | 409 `account_claimed` | The identity is now a claimed account; the anonymous recovery path is closed — the client prompts a sign-in instead of clearing its backup. |
  | 410 | User row no longer exists (GC'd or `/me/delete`d) — client should clear its backup, **not** mint a new identity here. |
  | 413 | Body > 4 KB. |
  | 429 | Rate limited (per-IP or per-sub) — sets `Retry-After`. |

  Note: 429 returns a bare `{ code: 'rate_limited' }` body (not the standard
  `errorResponse` shape) so it can carry the `Retry-After` header.

---

## Accounts routes (`/api/auth/**`)

The email/OAuth **accounts** routes (everything under `/api/auth/**` *except*
`/api/auth/restore`, documented above). They were added by the accounts
milestone and share a **separate, stricter guard stack** from the score/session
routes. See [`auth-gdpr.md`](../subsystems/auth-gdpr.md) for the identity,
session-store, and token model.

### Accounts route conventions

All under `src/app/api/auth/**`; every file sets `export const runtime =
'nodejs'` and `export const dynamic = 'force-dynamic'`.

| Concern | Mechanism | Source |
| --- | --- | --- |
| Front gate (mutations) | Every mutating handler first calls `await guardAuthMutation(request)` and returns its rejection if non-null. In order: **404** `not_found` when accounts are disabled (`isAccountsEnabled()` — hides the surface) → **403** `invalid_request` on a non-strict same-origin (`isSameOriginStrict`, fail-closed, stricter than `checkSameOrigin`) → **415** `invalid_request` on a non-JSON body (`isJsonRequest` — blocks the cross-site `<form>` CSRF vector) → **403** `invalid_request` on a missing/invalid CSRF double-submit token (`verifyCsrf`). A guard test asserts every mutating `/api/auth/**` handler calls it. | `src/lib/auth/routeGuard.ts:guardAuthMutation` |
| CSRF | Double-submit token. `GET /api/auth/session` (and most auth success responses) call `issueCsrfToken()`, which sets a cookie + returns the token; the client echoes it in a header on every auth POST, checked by `verifyCsrf`. | `src/lib/auth/httpGuards.ts` |
| Error envelope | `authError(code, status, error)` → `{ code, error }` (a bare string `code`, **not** a `ChatErrorCode`). | `src/lib/auth/routeGuard.ts:authError` |
| Rate-limit envelope | `rateLimited(retryAfterSec?)` → **429** `{ code: 'rate_limited', error }` + `Retry-After` (default 300s). Most mutations also call `checkAuthIp(extractClientIp(request))` (per-IP) up front. | `src/lib/auth/routeGuard.ts:rateLimited`, `authRateLimit.ts` |
| Body size | `readJsonBody(request)` caps the body at **4 KB** (content-length **and** decoded length), returning **413**/**400** on overflow/parse failure. | `src/lib/auth/routeGuard.ts:readJsonBody` |
| Identity | Authenticated routes use `getExistingRequestUser()` (401 when not signed in); the in-place "claim" routes (`signup`, OAuth `callback`) use `getRequestUser()` so they can act on the current anon. | `src/lib/auth/session.ts` |
| Success shape | JSON `{ ok: true, ... }` with `Cache-Control: no-store`. Routes that supersede the anon identity include `clearLocalStorage: ['sheet-llm:recovery']` so the client drops the now-dead recovery backup. | each `route.ts` |

`GET` routes (`session`, `sessions`, OAuth `start`/`callback`) are **not**
CSRF-gated — read-only or top-level navigations whose state changes are bound by
other means (the OAuth `state` cookie).

### `POST /api/auth/signup`

`src/app/api/auth/signup/route.ts`. Claim the **current anonymous identity** as
an email+password account *in place* (sessions/scores carry over), set
`claimed_at` (closing the anon recovery path), and mint a DB-backed login
session.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `readJsonBody`.
- **Body:** `{ email: string(email,≤254), password: string(10..200) }`.
- **Flow.** Reject disposable domains (`isDisposableEmail`) → reject if already
  signed in (`getRequestUser().authenticated`) → `hashPassword` (argon2id) →
  `claimAccountWithPassword(userId, email, hash, claimedAt)` → `createAuthSession`
  + `issueCsrfToken` → fire-and-forget verification email (within the send
  budget). Signup succeeds even if the email send fails (resend from settings).
- **Response (200):** `{ ok: true, emailVerified: false, clearLocalStorage:
  ['sheet-llm:recovery'] }`.
- **Status codes:** 400 `invalid_request` (bad email/short password) /
  `disposable_email`; 401 `invalid_request` (session expired mid-claim, `'gone'`);
  403 (cross-origin / CSRF); 404 (accounts disabled); 409 `already_authenticated`
  (already signed in) / `email_taken`; 413; 415; 429.

### `POST /api/auth/login`

`src/app/api/auth/login/route.ts`. Verify email+password and mint a fresh
DB-backed session. **Enumeration-resistant**: always runs a real argon2 verify
(against a lazily-computed dummy hash on a miss) so unknown-email and
wrong-password are time- and response-indistinguishable.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `readJsonBody`.
- **Body:** `{ email: string(email,≤254), password: string(1..200), rememberMe?:
  boolean }`.
- **Throttle ordering (deliberate).** A correct login short-circuits **before**
  the per-email failed-login throttle, so the throttle can never lock out the
  legitimate owner; only the failure path calls `checkEmailThrottle` +
  `recordEmailFailure`.
- **Response (200):** `{ ok: true, email, emailVerified, tier, clearLocalStorage:
  ['sheet-llm:recovery'] }`.
- **Status codes:** 400 `invalid_request`; 401 `invalid_credentials` (identical
  for unknown-email vs wrong-password); 403; 404; 413; 415; 429 (per-IP or
  per-email throttle).

### `POST /api/auth/logout`

`src/app/api/auth/logout/route.ts`. Revoke the current DB session and clear
`sl_sess` + `sl_auth` **and** the anon `sl_uid`, so the browser becomes a clean
visitor (a fresh anon is lazily minted on the next write).

- **Guard:** `guardAuthMutation` (no body read).
- **Response (200):** `{ ok: true, clearLocalStorage: ['sheet-llm:recovery'] }`.
- **Status codes:** 403; 404; 415. Idempotent — succeeds even with no live
  session.

### `POST /api/auth/logout-all`

`src/app/api/auth/logout-all/route.ts`. "Log out everywhere": revoke **every**
live DB session for the account (including this one), then clear cookies. Used
from account settings and after a password reset.

- **Guard:** `guardAuthMutation` → `getExistingRequestUser()` (401 if not
  signed in).
- **Response (200):** `{ ok: true, revoked: number, clearLocalStorage:
  ['sheet-llm:recovery'] }` (`revoked` = sessions killed).
- **Status codes:** 401 `not_authenticated`; 403; 404; 415.

### `GET /api/auth/session`

`src/app/api/auth/session/route.ts`. The client's **source of truth** for auth
state (nav, pro-gating). Always reads fresh from the DB. Also issues/refreshes
the CSRF double-submit token on **every** call, so the client holds a valid
token before any auth POST. Opportunistically GC's dead auth tokens/sessions
(`maybeReapAuth`).

- **Guard:** none (read-only GET; not CSRF-gated).
- **Response (200, `Cache-Control: no-store`):**
  - Accounts disabled: `{ enabled: false, authenticated: false, csrfToken }`.
  - Enabled, anon: `{ enabled: true, authenticated: false, csrfToken,
    oauthProviders: string[] }`.
  - Enabled, signed in: `{ enabled: true, authenticated: true, email,
    emailVerified, tier, csrfToken, oauthProviders }`.
  - `oauthProviders` lists which of `google`/`github` have credentials
    configured (so the UI shows the right buttons).

### `POST /api/auth/forgot`

`src/app/api/auth/forgot/route.ts`. Request a password-reset link. **Always
returns an identical 200** (no account enumeration). Real work (token + email)
happens only for an existing **password** account within the send budget;
OAuth-only accounts (null hash) silently no-op. The provider call is
fire-and-forget so response timing doesn't leak whether mail was sent.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `readJsonBody`.
- **Body:** `{ email: string(email,≤254) }`.
- **Response (200):** `{ ok: true }` (unconditional).
- **Status codes:** 403; 404; 413; 415; 429 (per-IP). A bad body still returns
  200 (the enumeration guard runs after schema parse).

### `POST /api/auth/reset`

`src/app/api/auth/reset/route.ts`. Set a new password from a **single-use**
reset token. Atomically consumes the token, writes the new hash, marks the email
verified (inbox control proven), and **revokes all sessions** (a reset is a
recovery action — force re-login everywhere, killing any attacker session). Does
**not** auto-login.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `readJsonBody`.
- **Body:** `{ token: string(20..512), password: string(10..200) }`.
- **Atomicity.** New password + revoke-all-sessions in one synchronous
  better-sqlite3 transaction, so a crash can't leave the new password live while
  old (possibly attacker) sessions survive. A password-changed email is sent.
- **Response (200):** `{ ok: true }`.
- **Status codes:** 400 `invalid_request` (bad body) / `invalid_token` (token
  invalid or expired); 403; 404; 413; 415; 429.

### `POST /api/auth/verify-email`

`src/app/api/auth/verify-email/route.ts`. Confirm an email address from the
verification link. **POST-only on purpose**: the email link points at a *page*
that posts on landing, so inbox scanners / link-prefetchers (GET-only) can't
silently consume the single-use token.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `readJsonBody`.
- **Body:** `{ token: string(20..512) }`.
- **Response (200):** `{ ok: true }`.
- **Status codes:** 400 `invalid_token` (bad/expired token); 403; 404; 413;
  415; 429.

### `POST /api/auth/verify-email/send`

`src/app/api/auth/verify-email/send/route.ts`. (Re)send the verification email
to the **currently authenticated** account. No body required. No-ops with 200
when already verified or the account has no email.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `getExistingRequestUser()`.
- **Response (200):** `{ ok: true }` or `{ ok: true, alreadyVerified: true }`.
- **Status codes:** 400 `no_email`; 401 `unauthenticated`; 403; 404; 415; 429
  (per-IP **or** send-budget); 502 `email_failed` (provider send threw).

### `POST /api/auth/change-password`

`src/app/api/auth/change-password/route.ts`. Authenticated. Verify the current
password, write the new hash, then **revoke all sessions and mint a fresh one
for this device** (rotation): a session stolen elsewhere is killed while the user
stays logged in here. A confirmation email is sent.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `getExistingRequestUser()`
  → `readJsonBody`.
- **Body:** `{ currentPassword: string(1..200), newPassword: string(10..200) }`.
- **Response (200):** `{ ok: true }`.
- **Status codes:** 400 `invalid_request` / `no_password` (OAuth-only account);
  401 `unauthenticated` / `invalid_credentials` (wrong current password); 403;
  404; 413; 415; 429.

### `POST /api/auth/change-email`

`src/app/api/auth/change-email/route.ts`. Authenticated. Verify the current
password (so a hijacked session can't silently move the address), set the new
normalized email, mark it **unverified**, and send a verification link to the
new address. The session is untouched.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `getExistingRequestUser()`
  → `readJsonBody`.
- **Body:** `{ newEmail: string(email,≤254), currentPassword: string(1..200) }`.
- **Response (200):** `{ ok: true, email, emailVerified: false }`.
- **Status codes:** 400 `invalid_request` / `disposable_email` / `no_password`;
  401 `unauthenticated` / `invalid_credentials`; 403; 404; 409 `email_taken`
  (unique-violation on the new address); 413; 415; 429.

### `GET /api/auth/sessions`

`src/app/api/auth/sessions/route.ts`. The authenticated user's **live** login
sessions for the account-settings "active sessions" list, with the current one
flagged. Tokens are never exposed. Read-only (no CSRF gate).

- **Guard:** `getExistingRequestUser()` (404 when accounts disabled, 401 when
  not signed in).
- **Response (200):** `{ sessions: AuthSessionSummary[] }`.

### `POST /api/auth/sessions/revoke`

`src/app/api/auth/sessions/revoke/route.ts`. Authenticated. Revoke **one** of
the user's *own* sessions by id ("sign out this device" from the list). Only
revokes a row belonging to the caller; revoking the current session simply logs
this device out.

- **Guard:** `guardAuthMutation` → per-IP rate-limit → `getExistingRequestUser()`
  → `readJsonBody`.
- **Body:** `{ id: string(1..100) }`.
- **Response (200):** `{ ok: true, revoked: boolean }` (`revoked` false if the
  id wasn't a live session of theirs).
- **Status codes:** 400 `invalid_request`; 401 `unauthenticated`; 403; 404;
  413; 415; 429.

### `GET /api/auth/oauth/[provider]/start`

`src/app/api/auth/oauth/[provider]/start/route.ts`. Begin an OAuth login. Mints
a CSRF `state` + PKCE `codeVerifier`, stashes them (+ a sanitized `returnTo`) in
a short-lived `SameSite=Lax` cookie, and **302-redirects** to the provider.
A top-level navigation, so it is not CSRF-gated — the account change at the
callback is bound to this `state`.

- **`provider`** is the dynamic segment (`ctx.params` is a Promise in Next 16),
  validated against `google`/`github` and required to be configured.
- **Response:** **302** redirect to the provider's authorize URL.
- **Status codes:** **404** (`Not found` text) when accounts disabled or the
  provider is unknown/unconfigured.

### `GET /api/auth/oauth/[provider]/callback`

`src/app/api/auth/oauth/[provider]/callback/route.ts`. The provider redirect
target. Exempt from the same-origin gate (a top-level redirect **from** the
provider); CSRF is enforced by the **single-use `state` cookie** instead. On
success mints a fresh login session and redirects to `returnTo`; on any failure
redirects with `?oauth_error=<code>`.

- **Flow.** Consume the flow cookie (single-use, no matter the result) →
  hard-fail on missing/mismatched `state` (the OAuth CSRF defense) → per-IP
  rate-limit → `exchangeCodeForUser` (PKCE token exchange) → `resolveOAuthLogin`
  (link to / claim the current identity) → `createAuthSession` + `issueCsrfToken`.
- **Response:** **302** redirect to the sanitized `returnTo` with either
  `?oauth=<kind>` (success) or `?oauth_error=<code>` (`denied` / `state` /
  `rate_limited` / `exchange` / a `resolveOAuthLogin` error). **404** text when
  accounts disabled or the provider is unknown/unconfigured.

---

## `/api/me/delete` — `DELETE`

`src/app/api/me/delete/route.ts`. GDPR Art. 17 right-to-erasure. Hard-deletes
the current user and everything that FK-cascades (sessions, messages,
score_versions). `export const dynamic = 'force-dynamic'`. See
[`auth-gdpr.md`](../subsystems/auth-gdpr.md).

- **Auth:** **`getExistingRequestUser()`** (get-only — never mints a phantom user
  to delete). Same-origin gated.
- **Body** (max 1 KB): `{ confirm: 'DELETE' }` (literal, server-side
  load-bearing confirmation — GitHub "delete repo" pattern).
- **Response (200):** `{ ok: true, deletedAt, deletedSessions,
  deletedMessages, deletedVersions, deletedAuthSessions, deletedOauthAccounts,
  deletedAuthTokens, clearLocalStorage: ['sheet-llm:recovery'] }`. Clears the
  anon `sl_uid` cookie **and** the DB-backed auth-session cookies
  (`clearAuthSessionCookies` — a claimed account deleting itself: its
  `auth_sessions` rows FK-cascade away, but the cookies don't); sets
  `Clear-Site-Data: "storage"` and `Cache-Control: no-store`. The
  `clearLocalStorage` directive tells the client wrapper to drop the recovery
  backup (else the next load would 410 on restore).
- **Status codes:** 400 `invalid_request` (body not `{ confirm: 'DELETE' }`);
  401 `invalid_request` (no active session); 403 `invalid_request`
  (cross-origin); 404 `chat_not_found` (account not found); 413
  `invalid_request` (> 1 KB).

---

## `/api/me/export` — `GET`

`src/app/api/me/export/route.ts`. GDPR Art. 15 / 20 right-of-access. Full JSON
dump of the current user's data. `export const dynamic = 'force-dynamic'`. See
[`auth-gdpr.md`](../subsystems/auth-gdpr.md).

- **Auth:** **`getExistingRequestUser()`** (get-only — a cookie-less caller must not
  download an empty dump of a just-minted account). Same-origin gated. No
  rate-limit (same-origin + cookie-scoped, cost bounded by the user's own
  data).
- **Response (200):** the export payload (`buildUserExport`) as
  pretty-printed JSON, with `Content-Disposition: attachment;
  filename="sheet-llm-export-YYYYMMDD.json"` (date, not userId, to keep PII out
  of the download list) and `Cache-Control: no-store`.
- **Status codes:** 401 `invalid_request` (no active session); 403
  `invalid_request` (cross-origin); 404 `chat_not_found` (row vanished between
  the cookie check and the export build — e.g. concurrent `/me/delete`).

---

## Cross-cutting status-code notes

- **422 has multiple meanings.** On `/api/chat` it is `refused` (copyright /
  policy), `validation_failed` (Score/ABC invalid after retries), or
  `output_too_large` (LLM hit `max_tokens` before completing the score). On
  `/api/import` it is `import_failed` (blocking parser/validation problem,
  with a `warnings[]` array). Same status, different `code` and body shape.
- **404 vs 410 for unknown chats.** `GET /api/chat` and the
  `sessions`/`fork`/`revert`/`confirm-replacement` routes use **404**;
  `POST /api/chat` uses **410** (`chat_not_found` / `chat_full`) to signal
  "this session is gone, start fresh."
- **409 is a conflict — CAS/freshness OR an accounts collision.** On the score
  routes: `stale_score` (chat), `stale_parent` (versions, with `currentHead`),
  nonce-replay (restore), or the no-prior-head reject edge case
  (confirm-replacement). On the accounts routes: `email_taken`
  (signup/change-email), `already_authenticated` (signup), and `account_claimed`
  (restore — the recovery token now belongs to a claimed account).
- **Two error envelopes.** Score/session/GDPR routes use
  `errorResponse(code, status, error, chatId?)` with a `ChatErrorCode`. The
  `/api/auth/**` accounts routes use `authError(code, status, error)` with a
  bare string `code` (and `rateLimited()` for 429). Don't assume a `ChatErrorCode`
  on an `/api/auth/**` response.
- **The `requiresConfirmation` candidate flow** spans two requests: a
  `/api/chat` POST surfaces `requiresConfirmation: true` + a
  `candidateVersionId` (head **not** advanced), and a follow-up
  `/api/chat/confirm-replacement` POST commits the decision. Both the
  replacement gate and the M24 ghost-preview proposal ride this same path.

## See also

- [`orchestrator.md`](../subsystems/orchestrator.md) — the `/api/chat`
  dispatch / refuse / gate brain.
- [`persistence-db.md`](../subsystems/persistence-db.md) — score-version
  chain, head pointer, CAS, idempotency.
- [`auth-gdpr.md`](../subsystems/auth-gdpr.md) — session/recovery + accounts
  (signup/login/OAuth/sessions) model and the `/me/*` endpoints.
- [`import.md`](../subsystems/import.md) — the import parser pipeline behind
  `/api/import`.
- [`ghost-preview.md`](../subsystems/ghost-preview.md) — the M24 proposal flow
  through `requiresConfirmation`.
- `src/app/api/chat/route.ts` — shared `errorResponse` / `checkSameOrigin` /
  `UuidSchema` / `synthToolUseId` used by every chat route.
- `src/lib/auth/routeGuard.ts` — `guardAuthMutation` / `authError` /
  `rateLimited` / `readJsonBody` shared by every `/api/auth/**` route.
- `src/lib/auth/session.ts` — `getRequestUser` / `getExistingRequestUser`, the
  claim-gating identity resolvers.
- `src/lib/shared/types.ts` — `ChatErrorCode` and all `*Response` wire types.
