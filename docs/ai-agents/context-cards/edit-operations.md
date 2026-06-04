---
title: Edit Operations & Score Transforms — Context Card
subsystem: edit-operations
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/editOperations.ts
  - src/lib/music/structuralOps.ts
  - src/lib/music/measureBalance.ts
  - src/lib/music/transformScoreBalanced.ts
  - src/lib/music/smartInsertNote.ts
  - src/lib/music/pasteEvents.ts
  - src/lib/music/scoreDiff.ts
  - src/lib/music/buildEventTimeIndex.ts
related:
  - orchestrator
  - score-data-model
  - score-validation
  - score-to-abc-sourcemap
  - chat-editor-state
---

Pure, immutable `Score`-transform layer: edit-op union + balance-preserving ops + content-hash diff.

## Files
- `editOperations.ts` — `Operation` union (~100+ kinds), `transformScore` (pure switch, NO validation), `applyOperation` (transform + validateScore → `EditError`), `Target`, structural handlers + helpers (`applyStructuralAppendOrInsert`, `applyRegionReplace`, `normalizeFinalPartial`, `withAllVoiceMeasures`). Clipboard-shared exports: `captureRangeContent`, `cloneCapturedRangeWithFreshIds`, `cloneCapturedRangeWithFreshIdsMapped` (D4: + old→new id map), `spansFullyInsideRange`/`remapSpansToFreshIds` (D4 copy/paste span-carry). `insertMeasuresAfter`/`regionReplace` ops gained optional `spansToAdd`.
- `structuralOps.ts` — `remapIndexAfterInsert`, `remapIndexAfterRegionReplace` (null=DROP), `remapScoreReferences`, move bundle (`extractRangeEntries`/`stripRangeEntries`/`reattachExtractedEntries`), span severance (`detectSeveredSpans`/`dropSeveredAndInteriorSpans`).
- `measureBalance.ts` — integer 32nd math. `DURATION_32NDS`, `MAX_CASCADE_DEPTH=2`, `BalanceError`+`BalanceErrorCode`, `decompose32nds`/`fillWithRests`/`fillMeasureWithRests`/`tieSplitOver`/`consumeForRoom`/`mergeAdjacentRests`/`isRest`.
- `transformScoreBalanced.ts` — `reorderBalanced`/`changeDurationBalanced`/`removeBalanced` (always meter-valid), `BalancedOp`/`BalancedTarget`.
- `smartInsertNote.ts` — `smartInsertNote()`+`scanAbsorbable()`: absorb-fit / shrink-to-fit / spillover. `SmartInsertResult`.
- `pasteEvents.ts` — `pasteEvents()` clipboard event-run paste + `packEventsIntoMeasures()`: fresh ids, absorb-fit into rest space OR spill (tie-split) into new meter-valid bars; tuplet-straddle refused (`ok:false`, no mutation). `PasteEventsResult`/`PasteEventsTarget`.
- `scoreDiff.ts` — `DIFF_ALGO_VERSION=2`, `scoreDiff()` (`retainedEventRatio`), `hashMeasure()` (FNV1a/id-free `canonEvent`), `computeAffectedEventIds()` (amber overlay).
- `buildEventTimeIndex.ts` — OUTLIER: abcjs `setupEvents()` + SourceMap → position→ms. No Score transform.

## Key types/exports
`transformScore(score, op): Score` · `applyOperation(score, op): Score` · `Operation` · `Target` · `EditError` · `transformScoreBalanced(score, op): Score` · `BalanceError`/`BalanceErrorCode` · `smartInsertNote(...): SmartInsertResult` · `pasteEvents(score, target, events): PasteEventsResult` · `scoreDiff(before, after): ScoreDiffResult` · `computeAffectedEventIds(before, after): string[]` · `buildEventTimeIndex(visualObj, sourceMap): EventTimeIndex`

## Env flags
None in this subsystem. (Gating lives in the orchestrator.)

## Gotchas (top)
- `transformScore` is PURE and does NOT validate — only `applyOperation` runs `validateScore`. Validate at the boundary.
- Spans are EVENT-ID based, not measureIdx — `remapScoreReferences` ignores them. Insert leaves them; regionReplace/delete must `dropSeveredAndInteriorSpans`; duplicate must mint fresh ids (`cloneCapturedRangeWithFreshIds`) or endpoints resolve ambiguously (last-write-wins). Measure copy/paste (D4) carries interior spans: `insertMeasuresAfter`/`regionReplace` take optional `spansToAdd` (appended AFTER the interior/severed drop), built via `spansFullyInsideRange`→`cloneCapturedRangeWithFreshIdsMapped` (id map)→`remapSpansToFreshIds`; straddlers dropped.
- Tuplets are atomic everywhere (split/consume/reorder/merge all reject them → `tuplet_blocked`/`tuplet_unsplittable`).
- `dragMeasureRange` shares ONE `case` label; modes are `if (op.mode===…)` guards — a new mode that forgets its branch silently falls into MOVE (comment at `editOperations.ts:1801`).
- `deleteEvent` on a measure's ONLY event converts it to a same-duration rest (id preserved), NOT a throw (#245 removed the old `EditError`). `removeBalanced` still rejects a last-event MOVE with `would_empty_measure`.
- `remapIndexAfterRegionReplace` returns `null`=DROP; surviving in-range refs pin to `start+count-1` (orphan policy, not re-anchor).
- `canonEvent`/`scoreDiff` are id-free and hash ONLY primary-staff/voice-0; empty `pitches[]` = explicit rest marker.
- Clear/preserve conventions differ per op family (strip-key-on-clear; `undefined`=preserve vs `null`=clear) — read the op comment. Clamps throw/truncate (octave 2..6, tempo 30..240, title 80 chars, chord ≤6 pitches).

## When editing X, also update Y
- New score-level entry with a `measureIdx` → wire into `remapScoreReferences` + `extractRangeEntries` + `stripRangeEntries` + `reattachExtractedEntries` (all four), else move/delete leaves it stale.
- New `Operation` variant → add a `transformScore` `case` + a test `editOperations.<feature>.test.ts`.
- New `dragMeasureRange` mode → add an `if` branch BEFORE the move fallthrough; pick a span/entry policy (move=preserve ids, duplicate=fresh ids).
- New retention field → bump `DIFF_ALGO_VERSION` + extend `canonEvent` (keep id-free).
- New `Duration` or meter denominator → must divide 32 (`DURATION_32NDS`).

## Related cards
`orchestrator` · `score-data-model` · `score-validation` · `score-to-abc-sourcemap` · `chat-editor-state`
