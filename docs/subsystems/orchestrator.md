---
title: LLM Orchestrator
subsystem: orchestrator
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-10
verified_against: 6de9175
source_paths:
  - src/lib/orchestrator/index.ts
  - src/lib/orchestrator/toolDispatch.ts
  - src/lib/orchestrator/haikuSingleCall.ts
  - src/lib/orchestrator/handlers/converse.ts
  - src/lib/orchestrator/classifier.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/generationTier.ts
  - src/lib/orchestrator/types.ts
  - src/lib/orchestrator/replacementDetect.ts
  - src/lib/orchestrator/preservationVerifier.ts
  - src/lib/orchestrator/observability.ts
  - src/lib/orchestrator/deadline.ts
  - src/lib/orchestrator/budget.ts
  - src/lib/orchestrator/scoreVersion.ts
  - src/lib/orchestrator/keyStatus.ts
  - src/lib/orchestrator/copyright/filter.ts
  - src/lib/providers/modelClass.ts
  - src/lib/music/scoreDiff.ts
  - src/app/api/chat/route.ts
related:
  - chat-route
  - score-data-model
  - music-edit-operations
  - providers-llm
  - score-versioning
---

The orchestrator is the brain behind every `/api/chat` request that needs LLM
reasoning over a `Score`. Its sole entry point, `run()` in
`src/lib/orchestrator/index.ts`, takes a user prompt plus the current score and
returns one of five typed outcomes (a score-producing result, a refusal, a
streaming converse iterator, a sectional score stream, or a fall-through that
defers to the legacy path).
Between intake and output it runs a synchronous copyright filter, picks a
handler (native tool-use dispatch by default, legacy Haiku classifier as the
rollback path), executes that handler, then runs two server-side gates —
**trust-nothing preservation verification** and a **replacement-as-confirmation
gate** — plus an **AI ghost-preview hook**, and finally persists a forensic
`orchestrator_turns` row. The architecture, flag, rollback, and replay
mechanics already have a deep reference at
[`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md); this
doc is the cross-cutting map and the canonical signature/invariant table — read
the README for the dispatch/verify/gate narrative, read this for "what calls
what, what must not break, and where to add code."

## Entry points

| Symbol | Where | What |
| --- | --- | --- |
| `run(input)` | `src/lib/orchestrator/index.ts` | The only production entry. Returns `OrchestratorRunOutcome`. The **route** owns mode gating; once inside `run()` it always executes. |
| `toolDispatch.run(input)` | `src/lib/orchestrator/toolDispatch.ts` | Native single-call tool dispatcher → `DispatchDecision`. |
| `classify(input)` | `src/lib/orchestrator/classifier.ts` | Legacy Haiku intent classifier → `Classification`. |
| `handleChat` (POST) | `src/app/api/chat/route.ts` | The **only** production caller of `runOrchestrator`. Resolves mode, supplies `deadlineAt`, persists results, and gates the head-version bump. |

`OrchestratorInput` / `OrchestratorResult` / `OrchestratorRefusal` /
`OrchestratorFallThrough` / `OrchestratorConverseStream` / `OrchestratorScoreStream`
are all defined in `src/lib/orchestrator/types.ts`. `isOrchestratorConverseStream(o)`
and `isOrchestratorScoreStream(o)` are the type predicates the route uses to
distinguish streaming converse and sectional score-stream outcomes from a
synchronous score result.

## Key files

| Path | Role |
| --- | --- |
| `src/lib/orchestrator/index.ts` | `run()`: deadline guards, copyright short-circuit, new-vs-legacy path selection, `dispatch()` (legacy switch), `runDispatchedHandler()` (new path), the `maybeApplyReplacementGate` + `maybeAttachGhostProposal` hooks, and every `recordTurn()` call. |
| `src/lib/orchestrator/toolDispatch.ts` | The 6-tool dispatcher (5 edit/structural tools + read-only `answer_question`). One `dispatch_to_handler` tool with a **flat** top-level schema (a `tool` enum + all per-tool fields hoisted to the top level), `toolChoice:'required'`, temp 0, `maxTokens:300`, ephemeral cache, `small` tier (Haiku — `resolveModelClass({callType:'dispatch'})` defaults to `small`). `repairBranchArgs` fills safe defaults for an empty branch; per-tool zod re-validation via `validateBranchArgs`; on a validation failure `run()` reroutes to `edit_intra_measure` (conf 0.6) rather than throwing. Optional `targetRegion` (D5) injects a structured selected-range hint. `DispatchToolName`, `DispatchToolNames`, `ToolDispatchError`, `STRING_CAP`=2000. |
| `src/lib/orchestrator/classifier.ts` | Legacy Haiku classifier (`classify()`, `ClassifierSchemaError`, `_resetClassifierClient()`). |
| `src/lib/orchestrator/classifierPrompt.ts` | `CLASSIFIER_SYSTEM_PROMPT`, `classifyTool`, `CLASSIFY_TOOL_NAME`. |
| `src/lib/orchestrator/flags.ts` | All env-flag accessors, read fresh every call (no caching). `getOrchestratorMode`, `isOrchestratorEnabled`, `isNewToolDispatchEnabled`, `isReplacementGateEnabled`, `isGhostPreviewEnabled`, `isSectionalGenEnabled`, `isBoundedGenEnabled` (M26), `isStreamAbortEnabled` (M26 PR-2, default-off), `isComposePatchDispatchEnabled` (deprecated). |
| `src/lib/orchestrator/generationTier.ts` | M26 product/paywall tier (`GenerationTier = 'free' | 'pro'`), ORTHOGONAL to the provider model-size `Tier`. Gates SCOPE and per-request ceilings, NOT model quality. `policyFor` → `GenerationPolicy` (`maxOutputTokens`/`maxBars`/`allowSectional`/`allowWholeScore`); `resolveGenerationTier` (force-free kill > dev-only client override > `SL_GENERATION_TIER` default > per-user entitlement); `BOUNDED_EMIT_CEILING`=2600, `BOUNDED_MAX_BARS`=4. The MODEL is chosen independently by `resolveModelClass` (`providers/modelClass.ts`): defaults to `small` (Haiku), escalates to `medium` (Sonnet) on `complexity:'complex'`, to `large` (Opus) only for heavy compositional calls with the Advanced Composer entitlement. |
| `src/lib/orchestrator/replacementDetect.ts` | Pure `detectReplacement()` gate decision + `REWRITE_KEYWORDS`, `ReplacementDecision`, `DetectReplacementInput`, `DispatchToolName`. |
| `src/lib/orchestrator/preservationVerifier.ts` | `verifyPreservation` / `verifyAllOriginalsPreserved` — re-hash retained measures via `hashMeasure`. |
| `src/lib/orchestrator/observability.ts` | `logTurn` / `recordTurn` / `logShadowDivergence`; `ERROR_MAX_LEN`=500, `RECOVERY_ERROR_MAX_LEN`=200. Inserts `orchestrator_turns` rows. |
| `src/lib/orchestrator/deadline.ts` | `computeDeadlineAt` (`DEADLINE_MS`, default 55000), `remainingMs`, `isDeadlineApproaching`. |
| `src/lib/orchestrator/budget.ts` | In-process per-chat token budget. `getSessionUsage`/`recordUsage`/`exceedsBudget`/`withUsageRecording`; caps default 200k in / 50k out. |
| `src/lib/orchestrator/keyStatus.ts` | `computeKeyStatus()` — per-tier provider-key status for the debug panel. |
| `src/lib/orchestrator/scoreVersion.ts` | `scoreHash(score)` — whole-Score SHA-256 (32 hex) for stale-submission detection on the wire. |
| `src/lib/orchestrator/copyright/filter.ts` | `checkCopyright(text)` — synchronous `<verb> <name>` co-occurrence match; PD-composer mention short-circuits to pass. |
| `src/lib/orchestrator/copyright/names.ts` | `HIGH_RISK_ARTISTS`, `HIGH_RISK_SONGS`, `INFRINGEMENT_VERBS`, `PD_COMPOSERS`. |
| `src/lib/orchestrator/handlers/extendComposition.ts` | `runExtendComposition` / `ExtendCompositionError`. Appends bars; `verifyAllOriginalsPreserved`; tie-at-boundary downgrade; cadence-at-boundary warn. |
| `src/lib/orchestrator/handlers/insertMeasures.ts` | `runInsertMeasures` / `InsertMeasuresError`. Mid-score insert + index remap; validation-retry-once. |
| `src/lib/orchestrator/handlers/regionReplace.ts` | `runRegionReplace` / `RegionReplaceError`. Range rewrite; severed-span warning; validation-retry. |
| `src/lib/orchestrator/handlers/editIntraMeasure.ts` | `runEditIntraMeasure` / `EditIntraMeasureError`, `INTRA_SYSTEM_PROMPT`. Surgical edits via a second LLM call emitting `Operation[]`. |
| `src/lib/orchestrator/handlers/compose.ts` | `runCompose` — full regeneration via `render_score`; houses the deprecated Lever-B sub-dispatch. Reached via `regenerate_all`. |
| `src/lib/orchestrator/handlers/generateBounded.ts` | `runGenerateBounded` / `GenerateBoundedError` (M26). ONE bounded `render_score` call (≤4-bar grand staff, `maxOutputTokens` = `BOUNDED_EMIT_CEILING`, no planner/sectional loop) — the free-tier fresh-generation path. Overflow throws `OutputTruncatedError` (clean 422). |
| `src/lib/orchestrator/handlers/scoreRetry.ts` | `callWithScoreRetry` — validation-retry loop + id backfill for `render_score` handlers. |
| `src/lib/orchestrator/handlers/{converse,generateComplex,generateSimple,editScoreLevel,refuse}.ts` | Streaming tutor; large-tier render; legacy Sonnet wrapper; deterministic no-LLM score-level ops (`runEditScoreLevel`/`EditHandlerError`); metadata-only refusal. |
| `src/lib/music/scoreDiff.ts` | `DIFF_ALGO_VERSION`=2, `scoreDiff()`, `hashMeasure()` (FNV1a over id-free `canonEvent`), `computeAffectedEventIds()`. The shared hash backbone. |
| `src/lib/music/structuralOps.ts` | Pure measure transforms + `remapIndexAfterInsert` / `remapIndexAfterRegionReplace` / `detectSeveredSpans`. |
| `src/lib/music/cadenceDetect.ts` | `detectCadenceAtFinalBarline` — warn-only cadence heuristic. |

> **Location gotcha:** `scoreDiff.ts`, `structuralOps.ts`, and
> `cadenceDetect.ts` live under `src/lib/music/`, NOT
> `src/lib/orchestrator/`. The orchestrator imports them via `@/lib/music`.
> Only `filter.ts` / `names.ts` live under `orchestrator/copyright/`.

## Core concepts / data flow

```
                /api/chat POST  (route.ts: handleChat)
                  │  resolves mode (getOrchestratorMode + debug override)
                  │  resolveGenerationTier(userId, debug.generationTier) -> generationTier (M26)
                  │  computeDeadlineAt() -> deadlineAt
                  ▼
        orchestrator.run(input)        [index.ts — mode gating is the ROUTE's job]
          │
          ├─ deadline guard (CLASSIFIER_ESTIMATED_MS = 2000) ─── approaching? → fallThrough('deadline_exceeded')
          │
          ├─ checkCopyright(userText)  ──── blocked? → OrchestratorRefusal (route → 422)
          │
          ├─ if genPolicy.tier==='free' && !editedScore && isBoundedGenEnabled(): ◀── FREE FRESH-GEN (M26)
          │     runGenerateBounded() → OrchestratorResult       [pre-dispatch choke point]
          │        (ONE render_score call, ≤4 bars, maxOutputTokens=BOUNDED_EMIT_CEILING,
          │         no planner/sectional loop; overflow → OutputTruncatedError → 422)
          │        run() records turn (handler 'generateBounded'), returns directly
          │
          ├─ elif input.editedScore && isNewToolDispatchEnabled(): ◀── EDIT path (DEFAULT)
          │     toolDispatchRun()  → DispatchDecision {tool, args, confidence=0.85}
          │        (ToolDispatchError → reroute to edit_intra_measure @ conf 0.6,
          │         NOT a fall-through; a hard dispatch throw → fallThrough)
          │     runDispatchedHandler(decision):
          │        free-tier scope gate: regenerate_all → runRefuse('pro_only') if !allowWholeScore
          │        deadline guard (HANDLER_ESTIMATED_MS = 8000)
          │        decision.tool:
          │          answer_question    → runConverse → OrchestratorConverseStream
          │                               (read-only Q&A; returns BEFORE finalizeDispatchResult,
          │                               skips both gates; run() returns the stream directly)
          │          extend_composition → runExtendComposition (targetBars clamped to policy.maxBars)
          │          insert_measures    → runInsertMeasures  (count clamped to policy.maxBars)
          │          region_replace     → runRegionReplace
          │          edit_intra_measure → runEditIntraMeasure
          │          regenerate_all     → runCompose (only if confirmExplicitRewrite===true,
          │                               else previewMode result, NO apply)
          │        → finalizeDispatchResult (score-producing tools only)
          │
          └─ else:                                                 ◀── LEGACY path (SL_NEW_TOOL_DISPATCH=0)
                classify() → Classification {kind, scope, complexity, confidence, ...}
                  (ClassifierSchemaError → fallThrough)
                deadline guard (HANDLER_ESTIMATED_MS) ; confidence < 0.6 → fallThrough('low_confidence')
                dispatch(classification): switch over 8 TaskKinds
                  edit_score_level / edit_intra_measure / generate_simple /
                  generate_complex / compose / converse / refuse / fall_through(null)
                  (generate_complex/compose on the PRO tier with no editedScore →
                   runGenerateSectionalStream → OrchestratorScoreStream, the M25 path)

      ── both score-result paths converge on the SAME finalization hooks ──
          maybeApplyReplacementGate(result, input)   → may set result.replacement + requiresConfirmation
          maybeAttachGhostProposal(result, input)    → ensureEventIds(score) then may set
                                                       result.proposal + requiresConfirmation
                                                       (no-op if replacement already fired)
          recordTurnT(input, ...)  → orchestrator_turns row (best-effort; stamps generationTier)
          return result

        route.ts respondWithOrchestratorResult (generationTier threaded for the debug payload):
          gateFired = result.requiresConfirmation === true
          appendMessages(..., gateFired ? {skipHeadVersionBump:true} : undefined)
          → if result.replacement: return replacement{...,candidateVersionId}
          → elif result.proposal:  return proposal{affectedEventIds, candidateVersionId}
          (head stays on prior version; /api/chat/confirm-replacement advances or reverts it later)

        route.ts fall-through handling (after run() returns a fallThrough):
          reason==='deadline_exceeded'      → clean 503 (NO legacy regen — the deadline
                                              must cap wall-clock, not chain a 2nd generation)
          generationTier==='free'           → clean 422 (free tier never runs the slow legacy
                                              full-score regen on a fall-through)
          else (legacy safety net)          → completeWithRetry; free tier (mode='off') still
                                              caps it to BOUNDED_EMIT_CEILING + maxRetries:1
```

### Dispatch paths (bounded-free / sectional-pro / new tool-use / legacy)

**Fresh from-scratch generation (no `editedScore`) forks on the product tier
(M26).** On the **free** tier (the default — the paywall is closed) `run()` hits
a pre-dispatch choke point right after the copyright filter: when
`genPolicy.tier === 'free' && !editedScore && isBoundedGenEnabled()` it delegates
to `runGenerateBounded` (ONE `render_score` call, ≤4 bars, capped at
`BOUNDED_EMIT_CEILING` output tokens, no planner loop) and returns an
`OrchestratorResult` directly — the gate/ghost hooks do **not** run on this fresh
result (there is no `editedScore` to diff against). On the **pro** tier the
bounded choke point is skipped and the fresh prompt falls to the classifier,
whose `generate_complex`/`compose` handler — when `isSectionalGenEnabled()` is on
(M25 default) and there is no `editedScore` — delegates to
`runGenerateSectionalStream` and returns an `OrchestratorScoreStream` (also
bypassing the gate/ghost hooks, since it is streamed progressively rather than
finalized server-side before return).

When `input.editedScore` exists and `isNewToolDispatchEnabled()` is on (the
default edit path), Claude native tool-use picks one of **six tools** (five
score-mutating + one read-only Q&A) and `runDispatchedHandler` executes it. With
`SL_NEW_TOOL_DISPATCH=0` (or for legacy TaskKinds), the Haiku classifier path
runs instead (a `classify()` call producing one of eight `TaskKind`s, then
`dispatch()`'s switch). The five score-mutating tools on both the native and
legacy edit paths converge on the identical gate + ghost hooks via
`finalizeDispatchResult` (new) and the tail of `run()` (legacy); `answer_question`
returns a stream before those hooks (see below).

### The 6 dispatch tools

Five score-mutating: `extend_composition`, `insert_measures`, `region_replace`,
`edit_intra_measure`, `regenerate_all`. The three tools that emit only NEW
measures (extend/insert/region) expose **no metadata fields** in their schemas,
so re-emitting `key`/`meter`/`title` is structurally impossible.
`regenerate_all`'s schema forces `confirmExplicitRewrite: z.literal(true)` plus a
`justification`.

**M26 per-tier scope enforcement in `runDispatchedHandler`:** on the free tier
`regenerate_all` is refused up front (`runRefuse` with `refusalCode 'pro_only'`,
route → 422) because `policyFor('free').allowWholeScore` is false, and
`extend_composition`/`insert_measures` have their `targetBars`/`count` clamped to
`policy.maxBars` (4) with a "switch to Pro for longer sections" warning appended.
Pro's budget (64 bars, `allowWholeScore`) leaves all of these untouched.

The sixth, `answer_question({ question })`, is the **read-only** option: it
routes a music-theory / analysis / "what's happening" question to `runConverse`
and returns an `OrchestratorConverseStream`. Without it, `toolChoice:'required'`
forced questions into `edit_intra_measure`, which then threw "model emitted no
ops" and fell through to the legacy score path — so a question got no answer.
Because it produces no Score, `runDispatchedHandler` returns its stream **before**
`finalizeDispatchResult`, so it bypasses preservation verify, the replacement
gate, and ghost preview entirely; it is therefore NOT mirrored into
`OrchestratorResult.dispatchTool` / `composePatchDispatch` /
`replacementDetect.ts:DispatchToolName` (those track score mutations only). It
maps to the `converse` `TaskKind`; the route streams it via
`respondWithConverseStream`.

### Trust-nothing preservation verification

`preservationVerifier.ts` re-hashes the measures a tool was supposed to leave
untouched (`verifyAllOriginalsPreserved` for `extend_composition`, which
implicitly retains every original bar) via `hashMeasure`. A mismatch means the
LLM silently mutated user work; the handler degrades to a warning / fall-through
rather than committing the corruption. `canonEvent` is **id-free**, so a
re-emitted measure with fresh uuids but identical content still hashes equal and
counts as retained. Out-of-range indices count as mismatches (impossible to
verify ≠ silent pass).

### Replacement-as-confirmation gate

`detectReplacement()` (pure, in `replacementDetect.ts`) fires only when **all**
of:

1. `retainedIdentityRatio < 0.5` (over half the before-measures no longer
   hash-match at the same index), AND
2. at least one of `key` / `meter` / `title` changed, AND
3. no explicit-rewrite signal — neither a `REWRITE_KEYWORDS` hit in `userText`
   nor `dispatchTool === 'regenerate_all' && confirmExplicitRewrite === true`.

On fire it sets `result.requiresConfirmation = true` and attaches
`result.replacement = { retainedIdentityRatio, reasons }`. The route skips the
head bump and returns a `replacement` payload the UI modal renders. Per-session
suppression is read from `sessions.replacement_gate_suppressed`
(`isReplacementGateSuppressed`, defense-in-depth: any DB error → "not
suppressed" → gate runs).

### AI ghost preview (M24)

`maybeAttachGhostProposal` runs **after** the gate and is mutually exclusive
with it (the gate wins). When `SL_GHOST_PREVIEW` is on, there is an
`editedScore`, no replacement already fired, `requiresConfirmation` is not
already set, and `scoreDiff` finds a real diff, it attaches
`result.proposal = { affectedEventIds }` (from `computeAffectedEventIds`) and
sets `requiresConfirmation = true`. Same head-bump-skip path as the gate; the
route disambiguates by **which field is populated** (`replacement` vs
`proposal`), since both set `requiresConfirmation`.

### Confidence is heuristic

The tool dispatcher has no native confidence — Anthropic exposes no tool-pick
logprobs — so `toolDispatch.run()` hardcodes `confidence: 0.85`.
`CONFIDENCE_FLOOR = 0.6` only gates the **legacy** classifier path
(`classification.confidence < CONFIDENCE_FLOOR → fallThrough('low_confidence')`).
Wrong-tool mistakes on the new path are caught downstream by the gate, not by a
confidence threshold.

### Failure isolation / fall-through

Known handler errors (`EditHandlerError`, `EditIntraMeasureError`,
`ExtendCompositionError`, `InsertMeasuresError`, `RegionReplaceError`) and
classifier/dispatch schema errors degrade to `OrchestratorFallThrough` (route
serves legacy). Transient errors — `RateLimitedError`, `UpstreamError`,
`ValidationError` — **re-throw** so the route maps status codes and avoids a
silent double-spend on the same prompt. `OutputTruncatedError` (thrown by the
Anthropic provider when `stop_reason === 'max_tokens'` before the zod parse)
also re-throws and is mapped to a clean 422 `output_too_large` by the route —
it is **not** a `ProviderSchemaError` and therefore does not trip provider
degradation. `ProviderSchemaError` (and generic orchestrator errors on the
score-stream path) are sanitized: raw detail is logged server-side and not
echoed to the client.

### Operating mode + kill switches

`getOrchestratorMode()` resolves `off | shadow | primary` with this precedence:
`ORCHESTRATOR_KILL=1` > `ORCHESTRATOR_ENABLED in {false,0}` >
`ORCHESTRATOR_MODE=shadow` > `primary`. In shadow, the legacy path always wins
the response and divergence is logged via `logShadowDivergence`. **Mode gating
is the route's job** — once execution is inside `run()`, it always runs.

## Env flags

| Flag | Default | Effect / accessor |
| --- | --- | --- |
| `SL_NEW_TOOL_DISPATCH` | **on** | Native 6-tool dispatcher. `0`/`false` → legacy Haiku classifier. `isNewToolDispatchEnabled` (`!readExplicitFalse`). |
| `SL_REPLACEMENT_GATE` | **on** | Replacement-confirmation gate. `0`/`false` → never mark `requiresConfirmation` via the gate. `isReplacementGateEnabled`. |
| `SL_GHOST_PREVIEW` | **on** | AI ghost preview (M24). `0`/`false` → silent commit, no proposal. `isGhostPreviewEnabled`. |
| `SL_SECTIONAL_GEN` | **on** | Sectional streaming generation for fresh scores (M25). `0`/`false` → falls back to single-shot `runGenerateComplex`. `isSectionalGenEnabled` (`!readExplicitFalse`). |
| `SL_BOUNDED_GEN` | **on** | M26 free-tier bounded ≤4-bar single-call generation. `0`/`false` → reverts free users to the legacy/sectional path WITHOUT opening the paywall. `isBoundedGenEnabled` (`!readExplicitFalse`). |
| `SL_HAIKU_SINGLE_CALL` | off | **SHE-19 PR2** free-tier single-call collapse for EDITS. `1` → an edit on the `free` tier (editedScore present) runs as ONE Haiku `tool_choice:'auto'` call (`haikuSingleCall.ts:runHaikuSingleCall`) that picks the action AND emits the ops, replacing the 2-call dispatcher→handler path; result still flows through `finalizeDispatchResult` (preservation + replacement gate). Off by default, hosted-free-tier-only; Anthropic-only; any throw falls back to the 2-call path. `isHaikuSingleCallEnabled` (`readBool`). |
| `SL_STREAM_ABORT` | off | M26 PR-2 secondary streaming kill-switch (the `streamGuard` wired into the Anthropic `textStream`). `1` → enforce mid-stream output-token / wall-clock cut-off on converse/text. `isStreamAbortEnabled` (`readBool`). |
| `SL_GENERATION_TIER` | free | Instance-wide product tier (`generationTier.ts:getGenerationTier`). `free` = paywall closed (bounded gen, whole-score Pro-only); `pro` = opens whole-score/sectional generation for everyone. |
| `SL_FORCE_FREE_TIER` | unset | Operator kill switch — `1`/`true` forces `free` for the whole instance regardless of any default/entitlement (`isForceFreeTier`). Highest precedence in `resolveGenerationTier`. |
| `SL_ALLOW_TIER_OVERRIDE` | unset | `1`/`true` → honor the CLIENT-supplied `debug.generationTier` even in production (paywall bypass; default-deny). Dev/test honor the override unconditionally (`isTierOverrideAllowed`). |
| `SL_ENTITLEMENTS_DB` | unset | `1`/`true` → `resolveGenerationTier` reads `users.tier` for an UPGRADE-only per-user `pro` grant (requires `email_verified=1`); else the instance default applies to everyone (`isEntitlementsDbEnabled`). |
| `SL_COMPOSE_PATCH_DISPATCH` | off | **DEPRECATED** Lever-B compose sub-classifier. Dead when the new dispatcher is on. `isComposePatchDispatchEnabled` (`readBool`). |
| `ORCHESTRATOR_KILL` | unset | Kill switch — `getOrchestratorMode` → `'off'`; route falls through to legacy every request. |
| `ORCHESTRATOR_ENABLED` | on | `false`/`0` → mode `'off'`. |
| `ORCHESTRATOR_MODE` | primary | `shadow` → runs alongside legacy (legacy wins; divergence logged). |
| `ORCHESTRATOR_LOG_SILENT` | unset | `1` (tests) → suppress `logTurn`/`recordTurn` stdout+DB and handler retry warnings. |
| `ORCHESTRATOR_BUDGET_INPUT_TOKENS` / `_OUTPUT_TOKENS` | 200000 / 50000 | Per-session caps in `budget.ts`; exceeding downgrades compose large→medium. |
| `DEADLINE_MS` | 55000 | Per-request wall-clock budget (`computeDeadlineAt`); bails before classifier (~2000ms est) or handler (~8000ms est). |

Note `SL_NEW_TOOL_DISPATCH`, `SL_REPLACEMENT_GATE`, `SL_GHOST_PREVIEW`,
`SL_SECTIONAL_GEN`, and `SL_BOUNDED_GEN` all use `readExplicitFalse` (default-on;
only an explicit `0`/`false` flips them), whereas `SL_STREAM_ABORT`,
`SL_HAIKU_SINGLE_CALL`, and `SL_COMPOSE_PATCH_DISPATCH` use `readBool`
(default-off). The product-tier flags
(`SL_GENERATION_TIER`, `SL_FORCE_FREE_TIER`, `SL_ALLOW_TIER_OVERRIDE`,
`SL_ENTITLEMENTS_DB`) live in `generationTier.ts`, not `flags.ts`.

## Invariants & gotchas

- **The dispatcher is NOT a real multi-tool `tool_choice:'auto'`.**
  `toolDispatch.callDispatch` wires a **single** tool `dispatch_to_handler`
  with a **flat** input schema — a top-level `tool` enum plus every per-tool
  field (`targetBars`, `afterMeasureIdx`, `count`, `startMeasureIdx`,
  `endMeasureIdx`, `hint`, `targetDescription`, `question`,
  `confirmExplicitRewrite`, `justification`) hoisted to the top level, all
  optional — called with `toolChoice:'required'`, then dispatched on the `tool`
  field server-side. (M26 follow-up flattened this: the earlier design nested
  each tool's args under a branch keyed by the tool name, but the model kept
  picking the tool and leaving the nested branch EMPTY — the provider stripped
  it and every structural request fell through. The flat shape matches how the
  model emits, so the args land; `validateBranchArgs` enforces per-tool required
  fields after the fact, since a flat schema can't conditionally require fields
  per `tool`.) The "pick one of six tools" framing in the README and prompt is a
  documentation abstraction over this single tool. (The code comments still
  mention `tool_choice='auto'`; the actual call passes `'required'`.) **The ONE
  genuine `tool_choice:'auto'` multi-tool call is the SHE-19 PR2 free-tier
  single-call collapse** (`haikuSingleCall.ts`, behind `SL_HAIKU_SINGLE_CALL`,
  Anthropic-only via `AnthropicProvider.multiToolCall`): it exposes the five
  real emit-tools and lets a plain-text reply stand in for answer/converse.

- **A bad dispatch tool-pick reroutes, it does not fall through.** If
  `validateBranchArgs` throws (the model picked a structural tool but supplied
  args that don't validate — commonly an empty `insert_measures` range), and
  `repairBranchArgs` had no safe default to fill, `toolDispatch.run()` catches
  the `ToolDispatchError` and returns a `edit_intra_measure` decision at
  `confidence: 0.6` carrying the user's own words as `targetDescription` — the
  catch-all surgical/structural edit handler — rather than dropping the turn to
  the slow whole-score legacy regen. Only a hard throw from the dispatch *call*
  (network/schema-shape failure) still falls through.

- **Three different hashes exist; do not confuse them.**
  `scoreVersion.ts:scoreHash` is a whole-Score **SHA-256** (32 hex) for
  stale-submission detection on the wire. `scoreDiff.ts:hashMeasure` is a
  **per-measure FNV1a** (over the id-free `canonEvent`) used by the verifier,
  the gate, telemetry, and the ghost preview. Bump `DIFF_ALGO_VERSION`
  (currently `2`) whenever `canonEvent`/`hashMeasure` changes — it is persisted
  per `orchestrator_turns` row for replay comparability.

- **`canonEvent` is intentionally id-free** (so re-emitted measures with fresh
  uuids still hash-equal / count as retained) and **collapses empty `pitches[]`
  to a canonical `'rest'`** (PR-7 fix), so empty-pitches rests don't spuriously
  hash-match unrelated empty-pitches events of other durations.

- **Replacement gate and ghost preview are mutually exclusive and
  order-dependent.** `maybeApplyReplacementGate` runs first; if it fires,
  `maybeAttachGhostProposal` short-circuits (`if (result.replacement) return`).
  Both set `requiresConfirmation`, so the route MUST disambiguate by **which
  field** is populated — it cannot rely on `requiresConfirmation` alone.

- **`regenerate_all` has defense-in-depth.** The zod/JSON schema forces
  `confirmExplicitRewrite === true`, but `runDispatchedHandler` ALSO re-checks
  it at runtime: if it ever leaks through false it returns a `previewMode`
  result (`requiresConfirmation = true`) **without applying** — it never
  silently regenerates the user's piece.

- **`REWRITE_KEYWORDS` deliberately omits the bare verbs `rewrite`/`replace`/
  `redo`** because they false-positive on negated intent ("please don't replace
  what I have"), which would silently disable the gate exactly when the user
  wants protection. Only unambiguous phrases survive (`from scratch`,
  `start over`, `scrap this`, `scrap that`, `recompose`, `compose anew`,
  `new piece`), all word-boundary matched. The `regenerate_all +
  confirmExplicitRewrite` signal covers the remaining explicit-rewrite cases.

- **`recordTurn` writes NULL (not 0) for `keyChanged`/`meterChanged`/
  `titleChanged`** when only one side of the diff exists (`boolToInt` preserves
  null) — writing 0 would falsely report "metadata preserved" for fresh
  generations. It also **skips the DB entirely** for missing/`'anonymous'`
  session ids (FK requires a real session) while still emitting the stdout line,
  and **swallows all insert errors** (re-emitted as an
  `orchestrator_turns_insert_failed` stdout line) so observability never breaks
  the request.

- **`composePatchDispatch` is an overloaded column/field.** In PR-3 its TS union
  and the `orchestrator_turns` column were broadened so the same string column
  records EITHER the legacy Lever-B `patch`/`regen`/`skipped` outcome OR the new
  dispatcher's picked tool name (`extend_composition`, etc.). Replay/analytics
  must interpret it contextually.

- **`budget.ts` state is in-process module-level Maps**, not persisted — it
  resets on every cold start / serverless instance and is not shared across
  instances. It is a best-effort soft cap that only downgrades compose's tier
  (large→medium Sonnet fallback) when exceeded.

- **Two deadline guards run inside `run()`:** one before the classifier
  (`CLASSIFIER_ESTIMATED_MS = 2000`) and one between classifier and handler
  dispatch (`HANDLER_ESTIMATED_MS = 8000`); the new dispatch path re-checks the
  handler budget inside `runDispatchedHandler`. These ms estimates are hardcoded
  rough constants, not per-provider measurements.

- **Two handlers return streaming outcomes rather than a completed `Score`.**
  `converse` returns `OrchestratorConverseStream` (hot AsyncIterable); the route
  owns its lifecycle and logs it as `ok` immediately without consuming it.
  `runGenerateSectionalStream` (M25) returns `OrchestratorScoreStream` (SSE
  section frames); `run()` records the turn then returns it, and the route
  drains it via `respondWithScoreStream`. Neither streaming path passes through
  the replacement gate or ghost preview hooks. Token usage for both is recorded
  by the route, not inside `run()`. **`converse` has two entry points:** the
  legacy classifier's `converse` `TaskKind` (logged in `run()`'s tail) AND the
  new dispatcher's `answer_question` tool (logged inside `runDispatchedHandler`,
  which returns the stream before `finalizeDispatchResult`). Both must record
  their own turn because `run()` returns the dispatch result directly.

- **`SL_COMPOSE_PATCH_DISPATCH` (Lever B) is dead code on the default path.**
  Compose is only reached via `regenerate_all`, which the route already treats
  as an explicit rewrite. The sub-dispatcher is live only on the
  `SL_NEW_TOOL_DISPATCH=0` opt-out.

## How to extend / common tasks

- **Add a new dispatch tool.** Add the name to `DispatchToolName` /
  `DispatchToolNames` in `toolDispatch.ts`, add a per-tool zod schema, add the
  tool's fields as **flat top-level properties** to BOTH the `inputSchema` zod
  object and the hand-written `inputSchemaJson` inside `callDispatch` (both must
  stay in sync — the JSON schema is what the model sees, the flat zod object is
  the first parse; required fields are NOT expressible per-`tool` in the flat
  schema, so enforce them in `validateBranchArgs`), update the tool count +
  decision rules + examples in `TOOL_DISPATCH_SYSTEM_PROMPT`, add a
  `validateBranchArgs` case (and optionally a `repairBranchArgs` default if a
  missing field can be safely guessed), then add a branch in
  `runDispatchedHandler` (`index.ts`) mapping it to a handler. For a **score-mutating** tool, also
  mirror the name into `OrchestratorResult.dispatchTool`,
  `LogTurnFields.composePatchDispatch`, and `replacementDetect.ts:DispatchToolName`
  so the column + gate stay in sync; if it emits only new measures, expose no
  metadata fields and have the handler call `verifyAllOriginalsPreserved`. A
  **read-only / streaming** tool (the `answer_question` → `runConverse` pattern)
  is the exception: return its outcome BEFORE `finalizeDispatchResult`, record
  its own turn inline, and do NOT add it to the three score-mutation unions
  above (it never reaches the gate).

- **Add a new score-producing handler.** Give it a dedicated `XError` class,
  return an `OrchestratorResult`, and add the error class to the
  `handler_error` discrimination in both `runDispatchedHandler`'s catch and
  `run()`'s legacy catch — otherwise a handler throw will re-throw as a 5xx
  instead of falling through. Use `callWithScoreRetry` (for `render_score`
  handlers) or the inline validation-retry-once pattern for `ValidationError`
  recovery; do NOT retry `ProviderSchemaError`/`Upstream`/`RateLimited`.

- **Change the hash / diff semantics.** Edit `canonEvent`/`hashMeasure` in
  `src/lib/music/scoreDiff.ts` and bump `DIFF_ALGO_VERSION`. This silently
  shifts the verifier, the gate's `retainedIdentityRatio`, the ghost preview's
  `computeAffectedEventIds`, and the persisted telemetry — re-run
  `src/lib/music/scoreDiff.test.ts`, `preservationVerifier.test.ts`,
  `replacementDetect.test.ts`, and the gate integration tests together.

- **Tune the gate.** Edit thresholds / `REWRITE_KEYWORDS` in
  `replacementDetect.ts` (pure, no I/O). Keep the negated-intent reasoning in
  mind before re-adding bare verbs.

- **Roll back a layer in prod** (no redeploy — flags are read every call):
  free-tier bounded gen → `SL_BOUNDED_GEN=0`; sectional gen → `SL_SECTIONAL_GEN=0`;
  dispatcher → `SL_NEW_TOOL_DISPATCH=0`; gate → `SL_REPLACEMENT_GATE=0`; ghost
  preview → `SL_GHOST_PREVIEW=0`; open the whole-score paywall for everyone →
  `SL_GENERATION_TIER=pro`; force every request to the free/bounded path →
  `SL_FORCE_FREE_TIER=1`; whole orchestrator → `ORCHESTRATOR_KILL=1`.

## Testing

Unit + integration tests live under `tests/unit/orchestrator/` and
`tests/integration/orchestrator/` (plus `src/lib/music/scoreDiff.test.ts`):

- Orchestration: `index.test.ts`; dispatch: `dispatch.test.ts`,
  `toolDispatch.test.ts`; classifier: `classifier.test.ts`,
  `composeApproach.test.ts`, `composeDispatch.test.ts`.
- Gates/verify: `preservationVerifier.test.ts`, `replacementDetect.test.ts`,
  `replacementGate.integration.test.ts`, `ghostPreviewGate.integration.test.ts`.
- Infra: `flags.test.ts`, `deadline.test.ts`, `deadline.dispatch.test.ts`,
  `budget.test.ts`, `budget.attempts.test.ts`, `keyStatus.test.ts`,
  `scoreVersion.test.ts`, `observability.test.ts`, `copyright.test.ts`,
  `costRegression.test.ts`, `summarizeAction.test.ts`.
- Handlers: `tests/unit/orchestrator/handlers/{extendComposition,insertMeasures,regionReplace}.test.ts`,
  `handlers.test.ts`, the `editIntraMeasure.*.test.ts` schema suite,
  `generateComplexAndCompose.test.ts`.
- Integration (route-level): `tests/integration/orchestrator/m3_5_default_dispatch.test.ts`,
  `tests/integration/api-chat-orchestrator-phase{0,1,2,3}.test.ts`,
  `api-chat-confirm-replacement.test.ts`.
- Live evals (`RUN_LIVE_EVALS=1`): `evals/cases/{additive,destructive,smoke,visual}`.

Set `ORCHESTRATOR_LOG_SILENT=1` in tests to keep stdout/DB writes quiet.

## Related files / see also

- [`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md) — the
  authoritative M3.5 dispatch/verify/gate/replay deep reference.
- `src/app/api/chat/route.ts` — the sole production caller; owns mode gating,
  head-bump skipping, and the `replacement` / `proposal` response shapes.
- `src/lib/music/scoreDiff.ts`, `src/lib/music/structuralOps.ts`,
  `src/lib/music/cadenceDetect.ts` — the music-layer helpers the orchestrator
  imports via `@/lib/music`.
- `evals/README.md` — live eval harness pinning dispatch + preservation
  invariants.
