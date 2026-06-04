---
title: Smoke & E2E Testing Runbook
subsystem: evals-testing
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - package.json
  - src/app/api/chat/route.ts
  - src/lib/orchestrator/index.ts
  - src/lib/orchestrator/handlers/generateComplex.ts
  - src/lib/orchestrator/handlers/compose.ts
  - src/lib/orchestrator/handlers/extendComposition.ts
  - src/lib/orchestrator/handlers/insertMeasures.ts
  - src/lib/orchestrator/handlers/regionReplace.ts
  - src/lib/orchestrator/handlers/scoreRetry.ts
  - src/lib/orchestrator/deadline.ts
  - src/lib/orchestrator/classifier.ts
  - src/lib/orchestrator/classifierPrompt.ts
  - src/lib/orchestrator/handlers/editScoreLevel.ts
  - src/lib/providers/anthropic.ts
  - src/lib/providers/openaiCompatible.ts
  - src/lib/providers/types.ts
  - src/lib/providers/callWithFailover.ts
  - src/lib/providers/degradation.ts
  - src/lib/llm/client.ts
  - src/lib/llm/renderScoreTool.ts
  - src/lib/music/types.ts
  - src/components/ErrorToast.tsx
  - src/components/PromptBar.tsx
  - src/app/api/import/route.ts
  - src/app/api/sessions/[id]/versions/route.ts
  - src/app/api/sessions/[id]/versions/batch/route.ts
  - tests/e2e/smoke.spec.ts
  - tests/integration/api-chat.test.ts
  - tests/integration/api-chat-orchestrator-phase0.test.ts
  - tests/integration/api-chat-orchestrator-phase1.test.ts
  - tests/integration/api-chat-orchestrator-phase2.test.ts
  - tests/integration/api-chat-orchestrator-phase3.test.ts
  - tests/integration/orchestrator/m3_5_default_dispatch.test.ts
  - tests/unit/orchestrator/generateComplexAndCompose.test.ts
  - evals/lib/buildLiveCase.ts
related:
  - evals-testing
  - orchestrator
---

# Smoke & E2E Testing Runbook

This is the canonical smoke + end-to-end testing plan for sheet-llm. It exists
because of one confirmed production regression and its cluster of siblings: the
prompt *"a driving blues-funk rhythm in grand staff. 16 bars with a turnaround at
the end"* returns **HTTP 500** with body
`Orchestrator failed: Tool input for render_score failed schema validation:
Invalid input: expected array, received undefined`.

The runbook does two jobs:

1. **Pins the regression and its blast radius** as a numbered smoke matrix
   (`SM-01`..`SM-19`) and a set of user-journey e2e scenarios, so the failure
   mode can never silently return.
2. **Names the prerequisite code fixes** (`PF-01`..`PF-09`) each test depends on,
   with `file:line` and the exact change, plus a release gate that ties them
   together.

> Read [`docs/subsystems/evals-testing.md`](../subsystems/evals-testing.md) first
> for the harness internals (mock vs live tiers, `buildLiveCase` gating,
> `describe.skipIf`, visual `pathDistance`). This doc layers the *what to test and
> why* on top of that *how the harness works*.

> **Status (verified at `150cb15`).** The core of this regression has since
> been **fixed** (largely by M25-PR-2 + M25-PR-6); much of the "Known gaps &
> prerequisite fixes" / "Release gate" framing below now describes *closed*
> bugs. The `68aacf8`-stamped `file:line` and constant values throughout are
> therefore **historical** unless flagged otherwise. What is now true at
> `150cb15`:
> - **PF-01 landed** — all five generation handlers use `MAX_TOKENS = 8_000`
>   (not the flat `4_000`); legacy `client.ts` raised `2_000 → 8_000` too.
> - **PF-02 landed** — `AnthropicProvider` throws a typed `OutputTruncatedError`
>   when `response.stop_reason === 'max_tokens'` (`anthropic.ts:168`), and
>   `ProviderToolResult` carries a normalized `stopReason`. The orchestrator
>   maps it (`index.ts`) and the route returns **422 `output_too_large`**
>   (`route.ts:508-515`) — no more cryptic Zod 500.
> - **PF-04 landed** — chat `MAX_BODY_BYTES = 1024 * 1024` (1 MB), well above the
>   32 KB single-version cap. **PF-05 landed** — `maxDuration = 300`.
> - **PF-06 landed** — `ErrorToast` no longer auto-dismisses and has a **Copy**
>   button. **PF-09 landed** — `changeClef` is in the classifier `ScoreLevelOp`
>   union. The repo-root DB artifacts are now gitignored (`.gitignore:54-55`).
> - **Still open:** PromptBar still destructures only `pending` (no inline
>   `error` surface) → **SM-08 / PF-07**; and `client.ts:81` still casts
>   `toolUse.input as Score` without a `ScoreSchema.safeParse` (the legacy
>   raised-ceiling part of PF-08 landed, the validation part did not) → **SM-13**.
> Treat the matrix below as the regression's audit trail; re-confirm any row
> against current source before acting on it.

## Root cause (ground truth — do not re-litigate)

> **Historical.** This is the chain *as it was at `68aacf8`*. Every link below
> has since been cut (see the status banner above); the `file:line`/constants are
> the original defect, not current source. Kept verbatim as the forensic record.

The 500 was **`max_tokens` truncation misreported as a schema error**. The chain:

```
generation handler sets a flat MAX_TOKENS that is too small for a two-staff piece
   src/lib/orchestrator/handlers/generateComplex.ts:21  MAX_TOKENS = 4_000   [now 8_000]
   (compose.ts:26 / extendComposition.ts:39 / insertMeasures.ts:26 / regionReplace.ts:170 all = 4_000;
    legacy single-shot src/lib/llm/client.ts:9 = 2_000)                       [all now 8_000]
        │  16-bar grand staff needs ~15-25k OUTPUT tokens
        ▼
model hits the ceiling MID render_score → tool_use.input is truncated, top-level
"measures" array is undefined. The provider never inspects stop_reason.        [FIXED: now does]
   src/lib/providers/anthropic.ts:77  messages.create — response.stop_reason ignored
        ▼
post-call zod safeParse fails on the missing required array → ProviderSchemaError
   src/lib/providers/anthropic.ts:111-116
        │  ProviderSchemaError (src/lib/providers/types.ts:151) is NOT a ValidationError
        ▼   [FIXED: anthropic.ts:168 now throws OutputTruncatedError BEFORE safeParse]
callWithScoreRetry does NOT retry it (only retries ValidationError)
   src/lib/orchestrator/handlers/scoreRetry.ts:122-123  if (!(e instanceof ValidationError)) throw e
        ▼
orchestrator dispatch catch RE-THROWS (only EditHandlerError/EditIntraMeasureError fall through)
   src/lib/orchestrator/index.ts:710  throw e   (cf. fall-through at index.ts:681)
        ▼   [FIXED: index.ts now special-cases OutputTruncatedError; route maps it to 422]
route maps the un-typed throw to a 500 echoing the raw zod string
   src/app/api/chat/route.ts:448-451  errorResponse('internal_error', 500, `Orchestrator failed: ${message}`)
        ▼   [now: route.ts:508-515 → errorResponse('output_too_large', 422, ...)]
ErrorToast auto-dismisses the message after 6s so the user can't even copy it
   src/components/ErrorToast.tsx:13  setTimeout(clearError, 6_000)             [FIXED: removed + Copy button]
```

**Asymmetry to fix:** the *refinement/dispatch* path falls through to legacy on a
handler throw (`src/lib/orchestrator/index.ts:681`, `fallThrough('handler_error', …)`),
but *fresh* `generate_complex`/`compose` **re-throws** (`index.ts:710`). Same error
class, opposite outcome — recovery for edits, a raw 500 for generation.

## How to run

All commands are the real `package.json` scripts (the `scripts` block, still
`package.json:9-32` at `150cb15` — the command set is unchanged since `68aacf8`).
The layers form a cost/coverage ladder: run the cheap
unit/integration suite and the mock evals freely; run live + visual evals on
demand because they spend real provider tokens.

| Layer | Command | Config / runner | What it is for | Cost |
| ----- | ------- | --------------- | -------------- | ---- |
| Unit + integration | `pnpm test` | `vitest run` excluding `**/eval/**`, `**/evals/**`, `**/tests/e2e/**` (`package.json:15`) | The default suite. Component (RTL), pure-logic unit, and `tests/integration/` API-route tests with a **stubbed** provider. Where `SM-02`/`SM-03`/`SM-04`/`SM-05`/`SM-06`/`SM-07`/`SM-08`/`SM-09`/`SM-10`/`SM-11`/`SM-12`/`SM-13`/`SM-14`/`SM-16` live. | free |
| E2E | `pnpm test:e2e` | `playwright test` (`package.json:23`) | Real browser against the app with a stub provider. `tests/e2e/smoke.spec.ts` + the journey specs. `SM-18` is here. | free |
| Mock evals | `pnpm eval:mock` | `vitest.evals.config.ts` (`package.json:18`) | Orchestrator behavior pinned against a **canned** provider (`evals/lib/mockProvider.ts`) — classification routing, additive-vs-replacement, no spend. | free |
| Live evals | `pnpm eval:live` | `vitest.evals.live.config.ts` (`package.json:19`) | Real Anthropic calls. **Gated**: cases `describe.skipIf` out unless `RUN_LIVE_EVALS=1` **and** `ANTHROPIC_API_KEY` set (`evals/lib/buildLiveCase.ts:79`); `expensive:true` cases also need `RUN_LIVE_FULL=1`. `SM-01` is a NEW live case here. Config is `passWithNoTests:true`, so running it without the flag is a clean zero-exit no-op. | per-case $ |
| Smoke evals | `pnpm eval:smoke` | `vitest.evals.smoke.config.ts`, `include: evals/**/*.smoke.eval.ts` (`vitest.evals.smoke.config.ts:19`) | A thin, cheap subset of live cases (classifier sanity) gated by `RUN_SMOKE_EVALS=1` — a fast "is the real model wired" check, not full coverage. | small $ |
| Visual evals | `pnpm eval:visual` | `vitest.evals.visual.config.ts` (`package.json:21`) | Renders reference scores to SVG and compares against pinned baselines within an `svgPathDistance` threshold. `SM-19` is here. Baselines captured via `pnpm eval:baselines:capture`. | per-case $ |
| Typecheck | `pnpm typecheck` | `tsc --noEmit` (`package.json:14`) | Type gate. Part of the release gate. | free |
| Lint | `pnpm lint` | `eslint` (`package.json:13`) | Lint gate. Part of the release gate. | free |

Live and visual tiers spend money; run them on demand (`pnpm eval:live` /
`pnpm eval:visual`):

```
RUN_LIVE_EVALS=1 ANTHROPIC_API_KEY=sk-... pnpm eval:live
```

## Smoke matrix

`Layer` maps to the table above. `Pass criteria` lists the prerequisite fix(es)
(`PF-*`, defined under [Known gaps & prerequisite fixes](#known-gaps--prerequisite-fixes))
each case needs to go green.

| ID | Name | Layer | Priority | Pass criteria |
| --- | ---- | ----- | -------- | ------------- |
| SM-01 | Large grand-staff generation succeeds end-to-end (the exact regression) | live-eval | P0 | New live case under `evals/cases/` (gated by `RUN_LIVE_EVALS=1`). POSTs the literal blues-funk prompt through orchestrator primary mode and asserts **HTTP 200** with a two-staff `Score` (`measures.length === 16` AND `secondStaff` with 16 bar-aligned measures), and `validateScore` passes. No `ProviderSchemaError`; latency under route `maxDuration`. Requires PF-01 + PF-05. |
| SM-02 | Truncated `render_score` (`stop_reason==='max_tokens'`) surfaces a typed error, not a cryptic Zod 500 | unit | P0 | Provider test on `AnthropicProvider.toolCall`: mock `messages.create` to resolve `{stop_reason:'max_tokens', content:[{type:'tool_use',name:'render_score',input:{title,key,meter}}]}` (measures omitted). Asserts the NEW typed truncation error (e.g. `OutputTruncatedError`) carrying the limit, **not** a bare `ProviderSchemaError` with `expected array, received undefined`. Mirror for `OpenAICompatibleProvider` with `finish_reason==='length'`. Requires PF-02. |
| SM-03 | Truncation on the generate path is recovered (retry / fall-through) with user-friendly status, not a raw 500 | integration | P0 | `POST /api/chat` (stub provider) where the first `render_score` simulates truncation. Asserts the orchestrator retries with a higher ceiling OR falls through to legacy, and the final HTTP response is **not** a 500 whose body contains the raw `Tool input for render_score failed schema validation: Invalid input: expected array, received undefined`. If it must error, it is a mapped 4xx/503 with sanitized copy. Requires PF-02 + PF-03. |
| SM-04 | Truncation-`ProviderSchemaError` does not poison the per-chat degradation tracker | unit | P1 | Unit test `callWithFailover` + `degradation`: feed two consecutive truncation errors on the same `chatId` + `'large'` tier. Assert `reportProviderFailure` is NOT called for the truncation case, so `isProviderDegraded(chatId,'large','anthropic')` stays `false` (`DEGRADATION_THRESHOLD=2`, `degradation.ts:13`) and the chat is not demoted to the fallback model. Requires PF-02. |
| SM-05 | Refinement POST carrying a realistic large grand-staff `editedScore` is accepted (body-size) | integration | P0 | `POST /api/chat`: build a REAL 16-bar grand-staff `Score` (two staves, per-event ids, ~16th-note groove, sized via `JSON.stringify` to exceed the OLD 24KB cap, ~30-35KB), send `{chatId, message:'make the turnaround busier', editedScore}`. Assert **NOT 413**; orchestrator dispatch reached. Distinct from the existing `tests/integration/api-chat.test.ts:452` ~10KB single-staff probe. Requires PF-04. |
| SM-06 | Chat body cap is >= the persistence (single-version) cap — sync-pin | unit | P1 | Static sync-pin asserting chat `MAX_BODY_BYTES` (`route.ts:53`, today `24*1024`) >= versions `MAX_BODY_BYTES` (`versions/route.ts:17`, `32*1024`) so the conversation layer can never silently regress below what the editor persists. Ideally aligned with the 1 MB batch per-score cap (`versions/batch/route.ts:28`). Requires PF-04. |
| SM-07 | Error toast persists (no 6s auto-dismiss) and is copyable | unit | P0 | RTL on `ErrorToast`: set a long error in the store, advance fake timers 7s, assert the toast is STILL rendered (no auto-clear for error severity) and a copy-to-clipboard control is present. Negative: the prior `setTimeout(clearError, 6_000)` path (`ErrorToast.tsx:13`) is gone or gated behind a non-error severity. Requires PF-06. |
| SM-08 | PromptBar surfaces the chat error inline near the input | unit | P1 | RTL on `PromptBar`: drive `useSubmitPrompt` to a failed submit; assert a persistent, dismissible inline error region renders beneath the input (`PromptBar.tsx:21` currently destructures only `pending`, never `error`). Assert the typed prompt is not silently lost (today `setInput('')` runs before the `await` at `PromptBar.tsx:31`/`:33`). Requires PF-07. |
| SM-09 | Raw internal/SDK/Zod strings are not rendered verbatim to users | integration | P1 | Integration test the error-mapping layer: trigger an orchestrator throw, a legacy "LLM call failed", and a missing-API-key `UpstreamError`. Assert `body.error` is a mapped safe message (per a `ChatErrorCode`→copy table) and raw exception / SDK / Zod text appears only in server logs. Requires PF-03 (c). |
| SM-10 | Compose / extend / insert / regionReplace large multi-staff render does not silently truncate | unit | P1 | Handler tests for `compose.ts`, `extendComposition.ts`, `insertMeasures.ts`, `regionReplace.ts`: assert each requests a token budget sized for a full two-staff score (estimate-driven or >= 16000), not the flat 4000. Replace the `expect(call.max_tokens).toBeGreaterThanOrEqual(4000)` at `tests/unit/orchestrator/generateComplexAndCompose.test.ts:89` with an estimate-driven check tied to target piece size. Requires PF-01. |
| SM-11 | Raising `max_tokens` does not silently convert the 500 into a 60s platform timeout | unit | P1 | Static/deadline test: assert route `maxDuration` (`route.ts:50`, today `60`) was raised in lockstep with the `max_tokens` increase, and that the deadline guard (`deadline.ts`: `DEFAULT_DEADLINE_MS`/`isDeadlineApproaching`) reflects the larger budget so it falls through early rather than letting an uninterruptible provider call exceed the function deadline. Requires PF-05. |
| SM-12 | Existing orchestrator happy paths still green | integration | P0 | Run the existing `api-chat-orchestrator-phase1/2/3` + `orchestrator/m3_5_default_dispatch` suites **unchanged** to confirm the prerequisite fixes don't regress classification routing or the five-tool dispatch (`extend_composition`/`insert_measures`/`region_replace`/`edit_intra_measure`/`regenerate_all`). All pass unchanged. |
| SM-13 | Legacy fall-through (Sonnet) validates and does not corrupt on truncation | unit | P1 | Unit test `client.ts`: feed a truncated `tool_use.input` (missing measures); assert it now runs `ScoreSchema.safeParse` and throws a typed error rather than casting `toolUse.input as Score` (`client.ts:80`) and propagating a corrupt object. Confirm legacy `MAX_TOKENS` raised from `2_000` (`client.ts:9`). Requires PF-08. |
| SM-14 | `changeClef` classifier op round-trips (schema not stale vs prompt + handler) | unit | P1 | Classifier test: feed `{kind:'edit_score_level', score_level_ops:[{kind:'changeClef',clef:'bass'}]}`. Assert `ClassificationSchema.safeParse` SUCCEEDS — today the `ScoreLevelOp` union (`classifier.ts:14-15` has `changeKey`/`changeMeter`, NO `changeClef`) rejects it though `classifierPrompt.ts:34,67` instructs it and `editScoreLevel.ts:24` already whitelists it in `ALLOWED_KINDS`. Add a sync-pin asserting the union variants match `ALLOWED_KINDS`. |
| SM-15 | `MAX_USER_TURNS` cap is intentional and surfaced (not a silent terminal 410) | integration | P2 | Send 20 successful turns, assert the 21st returns `410 chat_full` (matches `tests/integration/api-chat.test.ts:446-449`); AND assert failed/orphaned user turns (from 413s/timeouts) do NOT consume the turn budget, OR the client offers an auto-fork/new-session path. (`MAX_USER_TURNS=20`, `route.ts:54`.) |
| SM-16 | `render_score` wire-schema required keys are a subset of `ScoreSchema` required keys (drift pin) | unit | P2 | Static drift-pin diffing `renderScoreTool.input_schema.required` (`title,key,meter,tempo_bpm,clef,measures` — `renderScoreTool.ts:602`) against the non-optional keys of `ScoreSchema` (`key,meter,measures` — `types.ts:1103-1109`; `title`/`tempo_bpm`/`clef` are `.optional()`). Assert the wire `required` set does not declare keys `ScoreSchema` treats as optional in a way that diverges if strict mode changes. |
| SM-17 | No DB artifacts written to repo root during the test suite | manual | P1 | After `pnpm test`, assert neither `./sheet-llm.db` nor `./test-db-shouldnotexist/` exists (`git status --porcelain` clean of these). Broaden `.gitignore` to ignore `*.db` regardless of directory (today only `/data/` + `*.db-journal/-wal/-shm` are ignored, `.gitignore:47-50`). Confirm test factories use `:memory:` and no setup sets `DATABASE_URL` to a root-relative path. |
| SM-18 | E2E smoke: load → generate → render → MIDI/PDF download → New Score reset | e2e | P0 | Run the existing `tests/e2e/smoke.spec.ts` (Playwright, stub provider): blank staff on load, chat renders an `<svg>` score, MIDI `.mid` download, PDF `.pdf` download, New Score resets to blank. All 5 existing assertions pass. |
| SM-19 | Visual-regression baselines unchanged for reference scores | live-eval | P2 | Run `pnpm eval:visual`: Bach Invention 1, Chopin Nocturne Op9 No2, Mozart Eine Kleine Nachtmusik render within the `svgPathDistance` threshold of their pinned baselines. All three within threshold. |

## E2E scenarios

User-journey walkthroughs that span the full stack. Each is runnable locally with a
stub provider; the regression journey is also exercised live behind `SM-01`.

1. **Generate a large grand-staff piece from scratch (the regression journey).**
   Load the app (blank staff). Type *"a driving blues-funk rhythm in grand staff.
   16 bars with a turnaround at the end"* in the Music request box and Send. Expect a
   two-staff (treble + bass) score of 16 bars to render as SVG within the deadline —
   **NOT** a red "Orchestrator failed" toast. Verify the turnaround appears in the
   final bars. (Uses a canned large two-staff render; the gated live eval exercises
   the real model.)
2. **Truncation / oversized-piece graceful failure.** Request a piece so large the
   model cannot emit it in one pass (simulated truncation). Expect a CLEAR,
   persistent, copyable message (e.g. *"This piece was too large to generate in one
   pass — try fewer bars or split the request"*), NOT a cryptic
   `expected array, received undefined` 500 that vanishes in 6 seconds. Verify the
   message stays on screen until dismissed and a Copy button works.
3. **Refine a large generated/imported score (body-size round-trip).** Generate or
   import a dense 16-bar grand-staff score (~30-35KB). Make one manual note edit
   (sets `hasEdits`). Type a refinement (*"make the turnaround busier"*) and Send.
   Expect the `editedScore` round-trip to be accepted (no 413 "Request body too
   large"), the AI to refine, and the new score to render. Confirms persistence-vs-
   conversation cap parity.
4. **Manual edit → undo/redo → reset-to-LLM lifecycle.** Generate a score. Select a
   note, change its duration (`1`-`6` keys) and pitch (drag). Undo twice, redo once
   (verify the history pointer). Hit reset-to-LLM and confirm the score reverts to the
   AI baseline and redo is now empty. Verify a duration change on a tuplet member shows
   a visible status (toast/strip), not a silent no-op.
5. **Export round-trip (MIDI / PDF / MusicXML).** Generate a grand-staff score.
   Download MIDI (`.mid`), Download PDF (`.pdf`), and export MusicXML. Verify each
   produces a non-empty file and the MusicXML round-trips (two `<staff>` elements,
   voice reset). Verify exporting while a ghost proposal is pending exports the intended
   score (current overlay vs prior — confirm no silent wrong-score export).
6. **Reload / session restore.** Generate and edit a score, then reload. Expect the
   session to rehydrate from the server (transcript + head score version) within the
   orphan/reaper windows. Verify edits persisted via the batch path are present. Verify
   that after a server error the user's prompt is recoverable (`lastPrompt` retry), not
   silently lost.
7. **Conversation cap and recovery.** Iterate ~20 refinement turns in one session. On
   the 21st, expect a clear "conversation full" message (`410 chat_full`) with a forward
   path (New Score or auto-fork seeded from current head), not a dead end. Verify failed
   attempts (413/timeout) did not prematurely consume the turn budget.
8. **Confirmation gate / ghost preview accept-reject.** With an existing score, ask for
   a wholesale rewrite (*"start over as a jazz waltz"*). Expect the replacement-
   confirmation modal (gate fires). Reject → score unchanged. Repeat, Accept → head
   advances to the candidate. For a small edit, expect the inline amber ghost preview
   with accept/reject; verify Escape-dismiss does not orphan the candidate row without a
   reject, and a second prompt while a proposal is pending does not silently clobber the
   first.

## Coverage gaps

Confirmed-untested seams at `68aacf8`. Each is the test debt a smoke-matrix row pays
down.

- **Truncation guarding — NOW LANDED (PF-02).** At `68aacf8` the Anthropic tool path
  never read `response.stop_reason` and `ProviderToolResult` had no `stopReason`, so a
  `max_tokens` cutoff was indistinguishable from a schema error. At `150cb15` the provider
  reads `stop_reason` and throws `OutputTruncatedError` (`anthropic.ts:168`), `stopReason`
  is on `ProviderToolResult`/the stream events, and the route maps it to 422. Test debt may
  remain for some seams, but the code gap is closed. → SM-02, PF-02.
- **The exact production 500 chain is untested.** `tests/integration/api-chat-orchestrator-phase0.test.ts:143`
  throws a generic `Error('classifier exploded')`, never a `ProviderSchemaError` from
  `callWithScoreRetry`. No test follows `anthropic.ts:113` → `index.ts:710` re-throw →
  `route.ts:450` 500 with the verbatim `expected array, received undefined` body. → SM-03.
- **No realistic large-output generation test.** `tests/unit/orchestrator/generateComplexAndCompose.test.ts:89`
  asserts only `max_tokens >= 4000` (passes at the defective ceiling) and the shared
  `toolResponse` mock always returns a complete input with no `stop_reason`. → SM-10,
  PF-01.
- **No large-`editedScore` body-size test.** `tests/integration/api-chat.test.ts:111`
  probes a raw 25KB string in the `message` field; `:452` probes a ~10KB single-staff
  score. Nothing sends a realistic >24KB grand-staff `editedScore` to exercise the 413
  wall users hit on refinement. → SM-05, PF-04.
- **No sync-pin between the four score-carrying body caps.** chat `24KB`
  (`route.ts:53`), single-version `32KB` (`versions/route.ts:17`), batch `1MB`/score
  (`versions/batch/route.ts:28`), import `64KB` (`import/route.ts:40`). The conversation
  cap is silently the strictest — backwards from intent. → SM-06, PF-04.
- **ErrorToast auto-dismiss has no test.** `src/components/ErrorToast.tsx:13`
  (`setTimeout(clearError, 6_000)`) is unguarded; tests that mock `ErrorToast` out never
  assert the 6s dismissal or the absence of a copy affordance. → SM-07, PF-06.
- **PromptBar never reads `error`.** `src/components/PromptBar.tsx:21` destructures only
  `pending` from `useSubmitPrompt`. No test asserts an inline error surface near the input
  or that the typed prompt survives a failed submit (`setInput('')` at `PromptBar.tsx:31`
  runs before the `await` at `:33`). → SM-08, PF-07.
- **Degradation poisoning by truncation.** No test verifies that two truncation-induced
  `ProviderSchemaError`s on the same `chatId` + tier flip the chat to the fallback model
  via `callWithFailover` `reportProviderFailure` / `DEGRADATION_THRESHOLD=2`
  (`src/lib/providers/degradation.ts:13`) — nor, after the fix, that they do NOT. → SM-04,
  PF-02.
- **The generate-vs-refine asymmetry is untested.** The refinement/dispatch path falls
  through to legacy on a handler throw (`src/lib/orchestrator/index.ts:681`) but fresh
  `generate_complex`/`compose` re-throws (`index.ts:710`) — inconsistent 500 vs recovery
  for the same error class. → SM-03, PF-03 (b).
- **Legacy cast is unvalidated.** `src/lib/llm/client.ts:80` casts truncated
  `tool_use.input` to `Score` with no `ScoreSchema.safeParse` — a silent downstream
  corruption path, untested. → SM-13, PF-08.
- **`maxDuration=60` vs raised `max_tokens`.** No guard ensures the function-timeout
  ceiling (`route.ts:50`) moves in lockstep with the token budget, so the SM-01 fix could
  regress into a 504. → SM-11, PF-05.
- **`changeClef` classifier op — NOW WIRED (PF-09, M25-PR-6).** At `68aacf8` the
  `ScoreLevelOp` union in `src/lib/orchestrator/classifier.ts` omitted `changeClef` (a dead
  op the prompt + handler already expected). At `150cb15` it is present
  (`classifier.ts:18-22`), so "switch to bass clef" routes through the orchestrator. A
  schema-vs-`ALLOWED_KINDS` sync-pin (SM-14) is still worth keeping. → SM-14.
- **render_score-vs-ScoreSchema required-key drift.** `title`/`tempo_bpm`/`clef` are
  required in the wire schema (`renderScoreTool.ts:602`) but `.optional()` in
  `ScoreSchema` (`types.ts:1104,1107,1108`). No drift-pin. → SM-16.
- **No guard for stray DB artifacts.** The untracked `sheet-llm.db` and
  `test-db-shouldnotexist/` at repo root indicate a test not honoring `DATABASE_URL`;
  `*.db` outside `/data/` is not gitignored (`.gitignore:47-50`). → SM-17.
- **abcjs full round-trip has no end-to-end test** (Score → `scoreToAbcWithMap` →
  `abcjs.parseOnly` → `abcToScore` → equivalent Score), though the individual transpile/
  import legs ARE covered (`scoreToAbc.test.ts`, `abcToScore.test.ts`,
  `validateScore.test.ts`, `validateCrossRefs.test.ts`, `midiToScore.test.ts`,
  `normalize.test.ts` all exist).

## Known gaps & prerequisite fixes

These are the confirmed bugs the smoke matrix depends on. Land them before (or with)
the tests that pin them. Each lists `file:line` at `68aacf8` and the fix.

### PF-01 — Raise generation-path `max_tokens` to fit a full multi-staff piece (sized, not flat)
- **Files:** `src/lib/orchestrator/handlers/generateComplex.ts:21` (and `compose.ts:26`,
  `extendComposition.ts:39`, `insertMeasures.ts:26`, `regionReplace.ts:170`).
- **Fix:** Replace the flat `MAX_TOKENS = 4_000` with a ceiling sized for two-staff
  output (e.g. 16000-32000, within the Opus output cap), ideally derived from an estimate
  of target size (`measures × staves × voices`). Apply to all five generation handlers
  that emit a whole/large `Score`. Also raise the provider default from `2_000`
  (`src/lib/providers/anthropic.ts:79`, `src/lib/providers/openaiCompatible.ts:81`) or make
  `maxTokens` required so a forgetful caller cannot inherit the 2000 floor.
- **Pins:** SM-01, SM-10.

### PF-02 — Detect truncation explicitly: read `stop_reason`/`finish_reason` and throw a typed error
- **Files:** `src/lib/providers/anthropic.ts:77` (and `src/lib/providers/openaiCompatible.ts`;
  add `stopReason` to `ProviderToolResult` in `src/lib/providers/types.ts:88`).
- **Fix:** After `messages.create`, if `response.stop_reason === 'max_tokens'` throw a
  dedicated typed error (e.g. `OutputTruncatedError extends UpstreamError`, or a
  `ProviderSchemaError` subclass) carrying `max_tokens` and output tokens used — **before**
  `inputSchema.safeParse`, so a cutoff is never misreported as
  `expected array, received undefined`. Same for `choices[0].finish_reason === 'length'`
  in `openaiCompatible.ts`. This one check turns the symptom into a self-explanatory,
  classifiable error.
- **Pins:** SM-02, SM-03, SM-04.

### PF-03 — Make truncation recoverable on the fresh-generation path and stop leaking raw Zod text
- **Files:** `src/lib/orchestrator/handlers/scoreRetry.ts:122-123`,
  `src/lib/orchestrator/index.ts:710`, `src/app/api/chat/route.ts:448-451`.
- **Fix:**
  (a) In `scoreRetry.ts` add a branch that retries the typed truncation error (optionally
  bumping `maxTokens` / nudging re-emit), capped.
  (b) In the `index.ts` dispatch catch (~`665-711`), treat the typed truncation error (and
  `ProviderSchemaError`) like the dispatch path does — return
  `fallThrough('handler_error', …)` (cf. `index.ts:681`) instead of `throw e`, so the
  legacy single-shot path is a consistent safety net for fresh generation too.
  (c) In `route.ts:448-451`, map `internal_error` to a generic user-facing message and log
  the raw detail server-side rather than echoing the Zod string.
  (d) Do NOT call `reportProviderFailure` (`src/lib/providers/callWithFailover.ts`) for the
  truncation case so the chat is not demoted to the fallback model.
- **Pins:** SM-03, SM-09.

### PF-04 — Raise the chat-route body cap and unify it with the persistence caps
- **File:** `src/app/api/chat/route.ts:53`.
- **Fix:** Raise `MAX_BODY_BYTES` from `24*1024` to a realistic ceiling for two-staff
  scores (e.g. 256KB-1MB, aligning with the batch per-score 1MB `versions/batch/route.ts:28`
  and >= the 32KB single-version cap `versions/route.ts:17`). Keep the dual content-length
  + text-length guards (`route.ts:270`, `:280`). Add a sync-pin asserting
  `CHAT_MAX_BODY_BYTES >= versions MAX_BODY_BYTES`. Secondary: embed
  `JSON.stringify(editedScore)` compact (drop the `null, 2` pretty-print) to cut per-
  refinement input ~3×.
- **Pins:** SM-05, SM-06.

### PF-05 — Raise `maxDuration` in lockstep with the token-budget increase
- **File:** `src/app/api/chat/route.ts:50`.
- **Fix:** Raise `maxDuration` from `60` to a value that covers the worst-case full-score
  emit (e.g. 120-300 where the platform allows), and update the deadline guard in
  `src/lib/orchestrator/deadline.ts` (`DEFAULT_DEADLINE_MS = 55_000` and the
  `isDeadlineApproaching(deadlineAt, estimatedCallMs?)` estimate it feeds) so it falls
  through early rather than letting an uninterruptible provider call exceed the function
  deadline. Land this in the SAME change as the `max_tokens` raise so the 500 is not merely
  traded for a 504. (Optionally stream/chunk large generations as a follow-up.)
- **Pins:** SM-11; protects SM-01.

### PF-06 — Stop auto-dismissing error toasts and add a copy affordance
- **File:** `src/components/ErrorToast.tsx:13`.
- **Fix:** Remove the unconditional `setTimeout(clearError, 6_000)` for error-severity
  toasts (errors persist until the user dismisses, or the next submit clears them via the
  store's request-begin path). If a timer is kept for transient/info toasts, gate it by
  severity, make it much longer (e.g. 30s), pause on hover/focus, and add a visible
  Copy-to-clipboard button. Never auto-clear `internal_error`/`upstream_error` toasts.
- **Pins:** SM-07.

### PF-07 — Surface the chat error inline in PromptBar (and preserve the typed prompt)
- **File:** `src/components/PromptBar.tsx:21` (and `:31`/`:33`).
- **Fix:** Destructure `error` from `useSubmitPrompt` and render a persistent, dismissible
  inline error region beneath the input with a Retry action that re-submits the store's
  `lastPrompt`. Move `setInput('')` into the **success** branch (it currently runs at
  `PromptBar.tsx:31`, before the `await doSubmit(...)` at `:33`) so a failed prompt is not
  lost from the box.
- **Pins:** SM-08 (P1, optional for release).

### PF-08 — Validate legacy tool output and raise the legacy ceiling
- **File:** `src/lib/llm/client.ts:80` (and `client.ts:9`).
- **Fix:** Replace the bare `toolUse.input as Score` cast with `ScoreSchema.safeParse`
  (mirroring `anthropic.ts:111-116`) and check `stop_reason === 'max_tokens'`, throwing a
  typed error the route maps cleanly. Raise the legacy `MAX_TOKENS` from `2_000` to match
  the generation-path budget since this path still serves big pieces on fall-through.
- **Pins:** SM-13 (P1).

### PF-09 (supporting) — Wire `changeClef` into the classifier schema + prompt
- **Files:** `src/lib/orchestrator/classifier.ts:14-15` (the `ScoreLevelOp` union),
  `src/lib/orchestrator/classifierPrompt.ts` (the wire `oneOf`).
- **Fix:** Add a `changeClef` branch to the `ScoreLevelOp` zod union so
  `ClassificationSchema.safeParse` accepts `{kind:'changeClef',clef:'bass'}` — the prompt
  (`classifierPrompt.ts:34,67`) and handler (`editScoreLevel.ts:24` `ALLOWED_KINDS`)
  already expect it. Add a sync-pin asserting union variants match `ALLOWED_KINDS`.
- **Pins:** SM-14.

## Release gate

Ship the regression fix only when **all** of the following hold:

- [ ] **PF-01 + PF-02 + PF-03 landed:** generation-path `max_tokens` sized for multi-staff;
  `stop_reason` inspected → typed truncation error; the fresh-generation path no longer
  returns a raw-Zod 500 (retries or falls through with sanitized copy).
- [ ] **SM-01 green** (live-eval gated): a 16-bar grand-staff generation returns a valid
  two-staff `Score` — the exact regression.
- [ ] **SM-02 + SM-03 green:** simulated truncation yields a typed/clean user-facing error,
  never the cryptic `expected array, received undefined` 500.
- [ ] **SM-05 + SM-06 green:** a realistic >24KB grand-staff `editedScore` refinement is
  accepted (PF-04) and the chat body cap is >= the persistence cap.
- [ ] **SM-07 green:** the error toast persists past 6s and is copyable (PF-06).
- [ ] **SM-11 green:** `maxDuration` raised in lockstep with `max_tokens` (PF-05) so SM-01
  cannot regress into a 504.
- [ ] **SM-12 + SM-18 green:** the existing orchestrator integration suites
  (`phase1/2/3` + `m3_5_default_dispatch`) and the Playwright smoke spec pass **unchanged**.
- [ ] **SM-17 green:** `pnpm test` leaves no DB artifacts at repo root and `*.db` is
  gitignored.
- [ ] `pnpm typecheck` and `pnpm lint` clean.

## See also

- [`docs/subsystems/evals-testing.md`](../subsystems/evals-testing.md) — the harness
  internals (mock/live/smoke/visual tiers, gating, `pathDistance`).
- [`docs/reference/scripts.md`](../reference/scripts.md) — the full `pnpm` script index.
- [`docs/subsystems/orchestrator.md`](../subsystems/orchestrator.md) and
  [`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md) — dispatch,
  retry, fall-through, and the confirmation gate.
- [`evals/README.md`](../../evals/README.md) — the mock + live eval harness.
- Code: `src/app/api/chat/route.ts`, `src/lib/orchestrator/index.ts`,
  `src/lib/orchestrator/handlers/`, `src/lib/providers/anthropic.ts`,
  `src/lib/providers/types.ts`, `src/lib/llm/client.ts`,
  `src/lib/llm/renderScoreTool.ts`, `src/lib/music/types.ts`,
  `src/components/ErrorToast.tsx`, `src/components/PromptBar.tsx`,
  `tests/e2e/smoke.spec.ts`, `tests/integration/api-chat.test.ts`.
