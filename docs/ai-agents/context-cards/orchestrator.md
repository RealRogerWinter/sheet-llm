---
title: Orchestrator — AI Context Card
subsystem: orchestrator
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-10
verified_against: 8c99094
source_paths:
  - src/lib/orchestrator/index.ts
  - src/lib/orchestrator/toolDispatch.ts
  - src/lib/orchestrator/handlers/converse.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/generationTier.ts
  - src/lib/orchestrator/types.ts
  - src/lib/orchestrator/replacementDetect.ts
  - src/lib/orchestrator/preservationVerifier.ts
  - src/lib/orchestrator/observability.ts
  - src/lib/providers/modelClass.ts
  - src/lib/music/scoreDiff.ts
  - src/app/api/chat/route.ts
related:
  - chat-route
  - score-data-model
  - music-edit-operations
  - score-versioning
---

The `/api/chat` brain: copyright filter → tool-use dispatch (or legacy Haiku
classifier) → handler → preservation verify + replacement gate + ghost preview →
versioned Score result. Deep doc: `docs/subsystems/orchestrator.md`. Authoritative
internals: `src/lib/orchestrator/README.md`.

## Key files
- `index.ts` — `run()` entry: deadline guards, copyright, M26 free-tier bounded-gen choke point, new-vs-legacy select, `runDispatchedHandler`, gate + ghost hooks, all `recordTurnT` (wraps `recordTurn`, stamps `generationTier`). M26: a fresh from-scratch gen on the FREE tier (default) routes to `runGenerateBounded` (≤4-bar single call) BEFORE dispatch/classify; PRO fresh gen reaches `runGenerateSectionalStream` via the classifier when `isSectionalGenEnabled()`. Free-tier `runDispatchedHandler` refuses `regenerate_all` (`pro_only`) and clamps extend/insert bars to `policy.maxBars`. **SHE-8:** all four scope/paywall reads (bounded-gen choke point, sectional fork, `regenerate_all` gate, bar clamp) now come from a caller-injected `input.tierPolicy` (`TierPolicy`) via `effectiveTierPolicy(input)` — the kernel no longer imports `policyFor`/`generationTier`. Absent ⇒ `UNCAPPED_TIER_POLICY` (OSS-safe: uncapped, never bounded); `route.ts` injects the resolved, fail-closed capped policy. `maybeAttachGhostProposal` now calls `ensureEventIds(score)` first (else amber highlights nothing). `OrchestratorScoreStream` handled like `ConverseStream` (records turn, returned directly).
- `toolDispatch.ts` — 6-tool dispatcher (5 score-mutating + read-only `answer_question`→converse); ONE `dispatch_to_handler` tool with a FLAT top-level schema (`tool` enum + all per-tool fields hoisted, optional), `toolChoice:'required'`, `small` tier (Haiku via `resolveModelClass({callType:'dispatch'})`), temp 0, `maxTokens:300`, conf hardcoded 0.85. `repairBranchArgs` fills safe defaults for empty branches; on a `validateBranchArgs` failure `run()` REROUTES to `edit_intra_measure` @ conf 0.6 (NOT a fall-through). `STRING_CAP`=2000. Optional `targetRegion` (D5) → structured selected-range prompt hint.
- `flags.ts` — env accessors, read fresh every call; `isSectionalGenEnabled()` reads `SL_SECTIONAL_GEN` (default ON); `isBoundedGenEnabled()` reads `SL_BOUNDED_GEN` (default ON); `isStreamAbortEnabled()` reads `SL_STREAM_ABORT` (default OFF).
- `generationTier.ts` — M26 product/paywall tier (`GenerationTier='free'|'pro'`), ORTHOGONAL to provider `Tier`. Gates SCOPE/ceilings, NOT model quality. `policyFor`→`GenerationPolicy`, `resolveGenerationTier` (force-free > dev-only client override > `SL_GENERATION_TIER` > entitlement); SHE-8 `toTierPolicy(tier)`→`TierPolicy` is the SaaS adapter `route.ts` injects (the orchestrator no longer imports `policyFor` — this file is referenced only by `route.ts` now); `BOUNDED_EMIT_CEILING`=2600, `BOUNDED_MAX_BARS`=4. The MODEL is chosen by `resolveModelClass` (SHE-19): defaults to `small` (Haiku); escalates to `medium` (Sonnet) on `complexity:'complex'`; `large` (Opus) only for `whole_score`/`extend` with the Advanced Composer entitlement.
- `types.ts` — `OrchestratorInput/Result/Refusal/FallThrough/ConverseStream/ScoreStream`, `isOrchestratorConverseStream`, `isOrchestratorScoreStream`; `ScoreStreamEvent` (`'section'|'done'|'error'`); `ScoreLevelOperation` gained `changeClef`. M26/D5: `OrchestratorInput` gained `generationTier` + `targetRegion`; `RefusalCode` gained `'pro_only'`. SHE-8: added the `TierPolicy` interface + `OrchestratorInput.tierPolicy` (the injected scope/ceiling budget the kernel reads instead of importing `policyFor`).
- `replacementDetect.ts` — pure `detectReplacement()`, `REWRITE_KEYWORDS`.
- `preservationVerifier.ts` — `verifyPreservation` / `verifyAllOriginalsPreserved` (re-hash retained bars).
- `observability.ts` — `recordTurn`/`logTurn`; `orchestrator_turns` insert; `ERROR_MAX_LEN`=500.
- `classifier.ts` — legacy `classify()` (only on `SL_NEW_TOOL_DISPATCH=0` or no score).
- `handlers/` — `runExtendComposition/InsertMeasures/RegionReplace/EditIntraMeasure/Compose/Converse/GenerateBounded/...`; the structural + edit handlers carry a dedicated `XError` (`ExtendComposition/InsertMeasures/RegionReplace/EditIntraMeasureError`, `editScoreLevel` → `EditHandlerError`, M26 `generateBounded` → `GenerateBoundedError`); compose/converse/other generate handlers have none. `runEditIntraMeasure` is now TOLERANT — it skips ops that fail (→ `warnings`) and only throws if ZERO ops applied.
- `@/lib/music/scoreDiff.ts` — `hashMeasure`, `scoreDiff`, `computeAffectedEventIds`, `DIFF_ALGO_VERSION`=2 (NOT under orchestrator/).
- `src/app/api/chat/route.ts` — sole caller; owns mode gating + head-bump skip.

## Key types/exports
`run(input): Promise<OrchestratorRunOutcome>` = Result | Refusal | FallThrough | ConverseStream | ScoreStream | null.
6 tools: 5 score-mutating (`extend_composition | insert_measures | region_replace | edit_intra_measure | regenerate_all`) + read-only `answer_question` → `runConverse` (returns `ConverseStream`, maps to `converse` TaskKind, skips both gates). Questions about the score route here; before it existed, `toolChoice:'required'` forced them into `edit_intra_measure` → "model emitted no ops" → fell through with no answer.
Result carries `requiresConfirmation`, `replacement{retainedIdentityRatio,reasons}`, `proposal{affectedEventIds}`, `dispatchTool`, `warnings`.

## Env flags (default)
`SL_NEW_TOOL_DISPATCH`=on · `SL_REPLACEMENT_GATE`=on · `SL_GHOST_PREVIEW`=on · `SL_SECTIONAL_GEN`=on · `SL_BOUNDED_GEN`=on(M26) · `SL_STREAM_ABORT`=off(M26) · `SL_COMPOSE_PATCH_DISPATCH`=off(deprecated) · `ORCHESTRATOR_KILL`=unset · `ORCHESTRATOR_ENABLED`=on · `ORCHESTRATOR_MODE`=primary · `ORCHESTRATOR_LOG_SILENT`=unset · `DEADLINE_MS`=55000 · budget 200k/50k.
Product tier (`generationTier.ts`, NOT `flags.ts`): `SL_GENERATION_TIER`=free(paywall closed) · `SL_FORCE_FREE_TIER`=unset(operator kill→always free) · `SL_ALLOW_TIER_OVERRIDE`=unset(honor client `debug.generationTier` in prod) · `SL_ENTITLEMENTS_DB`=unset(per-user `users.tier` upgrade, needs verified email).
`SL_*GEN/DISPATCH/GATE/PREVIEW` flip off only on explicit `0`/`false` (`readExplicitFalse`); `SL_STREAM_ABORT` + `SL_COMPOSE_PATCH_DISPATCH` are default-off (`readBool`).

## Top gotchas
- Dispatcher is a SINGLE tool with a FLAT top-level schema (`tool` enum + all per-tool fields hoisted, optional) + `toolChoice:'required'`, not real `tool_choice:'auto'`; server dispatches on the `tool` field. (M26 flattened the old nested-per-tool-branch union — the model left branches empty and requests fell through.) On a `validateBranchArgs` failure `run()` REROUTES to `edit_intra_measure` @ conf 0.6 instead of failing the turn. Confidence 0.85 is hardcoded; `CONFIDENCE_FLOOR=0.6` gates ONLY the legacy path.
- M26 free tier (default): fresh from-scratch gen → `runGenerateBounded` (≤4 bars, `BOUNDED_EMIT_CEILING`=2600 max_tokens) BEFORE dispatch; `regenerate_all` refused (`pro_only`); extend/insert bars clamped to `policy.maxBars`=4. A `deadline_exceeded` OR any free-tier fall-through returns a CLEAN error (503/422) — the route does NOT run the slow legacy regen.
- Gate vs ghost preview are mutually exclusive + ordered (gate first, wins). Both set `requiresConfirmation` — route MUST check `replacement` vs `proposal` field, not the bool.
- 3 hashes: `scoreHash` = whole-Score SHA-256 (wire staleness); `hashMeasure` = per-measure FNV1a over id-free `canonEvent` (verifier/gate/telemetry/ghost). Bump `DIFF_ALGO_VERSION` when `canonEvent` changes.
- `canonEvent` is id-free (re-emitted uuids still retain) + collapses empty `pitches[]` to `'rest'`.
- `REWRITE_KEYWORDS` omits bare `rewrite`/`replace`/`redo` (negated-intent false positives). `regenerate_all` re-checks `confirmExplicitRewrite` at runtime; false → previewMode, NO apply.
- Transient errors (`RateLimited`/`Upstream`/`ValidationError`) RE-THROW; known handler/schema errors → `fallThrough`. `OutputTruncatedError` (thrown when `stop_reason==='max_tokens'` before the zod parse) is NOT a `ProviderSchemaError` and does NOT trip provider degradation — route maps it to a clean 422 `output_too_large`. `recordTurn` skips DB for `anonymous`/missing session, swallows insert errors, writes NULL (not 0) for one-sided diffs.

## When editing X, also update Y
- New dispatch tool → `DispatchToolName`+`DispatchToolNames`+per-tool zod schema, add the tool's fields as FLAT top-level props to BOTH `inputSchema` (zod) and `inputSchemaJson` (hand-written) in `callDispatch`, +`validateBranchArgs` (enforces per-tool required fields — the flat schema can't) +optional `repairBranchArgs` default +prompt (toolDispatch.ts), branch in `runDispatchedHandler` (index.ts). SCORE-MUTATING tools also: `OrchestratorResult.dispatchTool`, `LogTurnFields.composePatchDispatch` (observability.ts), `replacementDetect.ts:DispatchToolName`. READ-ONLY/streaming tools (the `answer_question`→converse exception) return BEFORE `finalizeDispatchResult`, record their own turn inline, and are NOT added to those 3 score-mutation unions.
- New `ScoreLevelOperation` variant → update both `classifier.ts` union AND the classify wire schema (`classifierPrompt.ts`); a mismatch causes the intent to fall through silently (e.g. `changeClef` was prompt-instructed but schema-rejected until M25).
- New handler error class → add to `handler_error` discrimination in BOTH `runDispatchedHandler` catch and `run()` legacy catch, else it 5xx's instead of falling through.
- `canonEvent`/`hashMeasure` change → bump `DIFF_ALGO_VERSION`; re-run scoreDiff/preservationVerifier/replacementDetect + gate integration tests.
- New `requiresConfirmation` source → route `respondWithOrchestratorResult` must branch on the new field (replacement/proposal/previewMode).

## Related cards
chat-route · score-data-model · music-edit-operations · score-versioning · providers-llm
