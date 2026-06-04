---
title: Edit Operations & Score Transforms
subsystem: edit-operations
audience: [contributor, ai-agent]
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
  - score-to-abc-sourcemap
  - score-validation
  - chat-editor-state
---

# Edit Operations & Score Transforms

This subsystem is the pure, immutable transform layer over the `Score`
data model: every edit — whether from an LLM tool-call, a ⌘K palette
action, or a direct editor gesture — funnels through a function here
that takes a `Score` and returns a **new** `Score`. It owns three
distinct vocabularies that share one design rule (pure, immutable, no
hidden I/O):

1. the **discriminated-union edit-op** vocabulary
   (`transformScore` / `applyOperation`) that the orchestrator dispatches,
2. the **balance-preserving** direct-manipulation ops
   (`transformScoreBalanced`) that keep every measure summing to its
   meter via integer 32nd-note arithmetic, and
3. the **content-hash diff** (`scoreDiff`) the orchestrator uses for
   preservation-verify, the replacement gate, and the ghost-preview
   amber overlay.

Plus three specialised helpers: `smartInsertNote` (note entry with
rest-absorption / spillover), `pasteEvents` (clipboard event-run paste —
absorb-fit, else spill into new bars) and `buildEventTimeIndex` (the
outlier — it maps abcjs render timing back to score positions for synth
seeking).

## Entry points

| Function | File | What it does |
|---|---|---|
| `transformScore(score, op): Score` | `editOperations.ts` | Pure dispatcher over the `Operation` union (~100+ kinds). Returns a new Score. **Does NOT validate.** |
| `applyOperation(score, op): Score` | `editOperations.ts` | `transformScore` then `validateScore`; re-throws validator failures as `EditError`. This is the boundary callers should use. |
| `transformScoreBalanced(score, op): Score` | `transformScoreBalanced.ts` | Meter-preserving `reorderBalanced` / `changeDurationBalanced` / `removeBalanced`. Throws `BalanceError`. |
| `smartInsertNote(score, target, defaults, staffIdx?, voiceIdx?): SmartInsertResult` | `smartInsertNote.ts` | Rest-absorbing note entry. Returns `{ score, newSelection, statusMessage? }`. |
| `pasteEvents(score, target, events): PasteEventsResult` | `pasteEvents.ts` | Clipboard event-run paste: fresh ids, absorb-fit into rest space, else spill into new meter-valid bars. Returns `{ ok, score, newSelection?, statusMessage? }` (no mutation on tuplet-straddle refusal). |
| `scoreDiff(before, after): ScoreDiffResult` | `scoreDiff.ts` | Pure before/after diff: counts, change booleans, `retainedEventRatio`. |
| `computeAffectedEventIds(before, after): string[]` | `scoreDiff.ts` | AFTER-side event ids that changed/inserted — feeds the amber overlay. |
| `buildEventTimeIndex(visualObj, sourceMap): EventTimeIndex` | `buildEventTimeIndex.ts` | Maps abcjs `setupEvents()` timing → `(staff:voice:measure:event)` → ms. |

## Key files

| Path | Role |
|---|---|
| `src/lib/music/editOperations.ts` | The ~3900-line core. Defines `Target`, the `Operation` discriminated union, `EditError`, the pure `transformScore` switch, and `applyOperation`. Holds the structural handlers (`appendMeasures` / `insertMeasuresAfter` / `regionReplace` / `dragMeasureRange`) and helpers (`applyStructuralAppendOrInsert`, `applyRegionReplace`, `normalizeFinalPartial`, `withAllVoiceMeasures`). Exports the clipboard-shared range helpers: `captureRangeContent`, `cloneCapturedRangeWithFreshIds`, `cloneCapturedRangeWithFreshIdsMapped` (D4: also returns the old→new event-id map), `spansFullyInsideRange` (D4: both endpoints inside a range), `remapSpansToFreshIds` (D4: rewrite copied-span endpoints + mint fresh span ids). |
| `src/lib/music/structuralOps.ts` | Pure side-effect helpers for measure add/remove/replace: `remapIndexAfterInsert`, `remapIndexAfterRegionReplace`, `remapScoreReferences`, the `dragMeasureRange` move bundle (`extractRangeEntries` / `stripRangeEntries` / `reattachExtractedEntries`), and span severance (`detectSeveredSpans` / `dropSeveredAndInteriorSpans`). Exports `PerVoiceMeasures`, `ExtractedRangeEntries`. |
| `src/lib/music/measureBalance.ts` | Integer 32nd-note arithmetic. `DURATION_32NDS`, `MAX_CASCADE_DEPTH=2`, `BalanceError` + `BalanceErrorCode`. Primitives: `decompose32nds`, `fillWithRests`, `fillMeasureWithRests`, `tieSplitEvent`, `tieSplitOver`, `consumeForRoom`, `mergeAdjacentRests`, `isRest`, `durationTo32nds`. |
| `src/lib/music/transformScoreBalanced.ts` | The balanced edit layer. `reorderBalanced` (within/cross-measure with tie-cascade), `changeDurationBalanced` (shrink/grow/cascade), `removeBalanced`. `BalancedTarget` + `BalancedOp` types. |
| `src/lib/music/smartInsertNote.ts` | `smartInsertNote()` + `scanAbsorbable()`: rest-absorbing note insertion (absorb-fit / shrink-to-fit / spillover). `SmartInsertResult`, `SmartInsertDefaults`. |
| `src/lib/music/pasteEvents.ts` | `pasteEvents()` clipboard event-run paste + `packEventsIntoMeasures()` (private: tie-split a run across meter-valid bars). `PasteEventsTarget`, `PasteEventsResult`. Absorb-fit splice, else spill into new bars. |
| `src/lib/music/scoreDiff.ts` | Content diffing. `DIFF_ALGO_VERSION=2`, `scoreDiff()`, `hashMeasure()` (FNV1a over id-free `canonEvent`), `computeAffectedEventIds()`. |
| `src/lib/music/buildEventTimeIndex.ts` | Post-render timing index. Walks abcjs `setupEvents()` output through the `SourceMap` (`resolveClickPosition`) to position→ms. Does NOT transform a Score. |

## Core concepts & data flow

### Op vocabulary and the pure/validating split

`Operation` is a `kind`-tagged union (`editOperations.ts:98`) spanning
per-pitch/per-event markings, score metadata, staff/voice/measure
structure, markers/voltas/jump-markers/annotations, and 9 span
families. `transformScore` is a single `switch (op.kind)` that builds a
new Score via the accessor wrappers (`withPitch` / `withEvent` /
`withVoiceMeasure`) for note-level ops, root-spread for metadata ops,
and the structural handlers below for measure-count changes.

`transformScore` is **pure and does not validate**. `applyOperation`
is the validating wrapper:

```
applyOperation(score, op):
  next = transformScore(score, op)      // may produce a transiently-invalid Score
  try { validateScore(next) }
  catch (e) { throw new EditError(`Edit produced an invalid score: ${e.message}`) }
  return next
```

The `EditError` message is load-bearing: the retry pipeline
(`scoreRetry.ts`, in the orchestrator) feeds it verbatim back to the
LLM so the model can re-target on the next turn. That is why the
addressing guards throw *descriptive* errors — see below.

### Target addressing

`Target = { staffIdx?, voiceIdx?, measureIdx, eventIdx, pitchIdx? }`
(`editOperations.ts:90`). `staffIdx` / `voiceIdx` default to `0` so
legacy single-staff single-voice edits keep working. Out-of-range
addressing throws `EditError` via three guards, each producing a
message that tells the LLM the valid range:

- `assertVoiceExists(score, staffIdx, voiceIdx)` — checks both staff and voice.
- `assertStaffExists(score, staffIdx)` — measure-level ops (barlines etc.) that don't target a voice; stricter than the voice guard because `getStaffMeasures` would otherwise silently fall back to `score.measures` on a missing `secondStaff` and produce a misleading no-op.
- the `withPitch` range guard — a `pitchIdx` outside the chord throws rather than silently rebuilding the event unchanged (a silent no-op would pass `validateScore` and report false success).

### Integer 32nd-note duration math

`measureBalance.ts` works exclusively in **32nd-note units**.
`DURATION_32NDS` maps `whole=32` down to `'32nd'=1`. Every allowed
`Duration` and every allowed meter denominator divides 32, so all
arithmetic is integer-exact — no epsilon comparisons, no float drift
across a chain of edits. `meterCapacityIn32nds` (from `meter.ts`)
gives a measure's capacity.

> Gotcha: eighth-based duplicate duration tables exist in
> `validateScore.ts` and `import/normalize.ts`. They predate this
> module and are **intentionally left un-consolidated** (they serve the
> validator / anacrusis-padding paths). Don't "fix" the duplication
> assuming it's an oversight.

`decompose32nds(units)` does a greedy largest-first split into a
`Duration[]`; because the enum contains `1`, every positive integer
decomposes. `fillWithRests` / `fillMeasureWithRests` synthesize pure
padding rests (no carry-over metadata). Use `fillMeasureWithRests(meter)`
anywhere you'd be tempted to hard-code `duration:'whole'` for an empty
bar — that only sums correctly in 4/4 and breaks the
measure-duration invariant in 3/4, 6/8, 5/4, etc.

### The measure-duration invariant (balanced ops)

`transformScoreBalanced` ops **guarantee** `sum(event durations) ==
meter capacity` after every edit:

- **shrink** (`changeDurationBalanced` newUnits < oldUnits): fill the freed space with rests immediately after the event; `mergeAdjacentRests` collapses them.
- **grow**: `consumeForRoom` eats following events; if the note overflows the bar, `tieSplitOver` cascades it into later bars as a tied chain.
- **remove** (`removeBalanced`): replace the event with rests of equal duration.
- **reorder** (`reorderBalanced`): within-measure (total preserved, no rebalance) or cross-measure (displace at destination, fill the gap at source, cascade if it overflows).

Tuplets are **atomic** and the only-event-in-a-measure cannot be moved
out. Failures surface as `BalanceError` with a UX-toast `code`:

| code | when |
|---|---|
| `tuplet_blocked` | would orphan / partially consume a tuplet group, or drop lands inside one |
| `tuplet_unsplittable` | the moved/split event itself is a tuplet member |
| `cascade_overflow` | note too big for remaining measures (or exceeds `MAX_CASCADE_DEPTH`) |
| `would_empty_measure` | moving out the last event of a measure |
| `unrepresentable` | indices out of range, drop position invalid, non-integer 32nd parts |

### Tie-cascade (`tieSplitOver`) and `MAX_CASCADE_DEPTH`

A note too long for the remaining room in its destination is split
into a tied chain across consecutive measures, capped at
`MAX_CASCADE_DEPTH = 2` *extra* measures (3 total). `decoratePart` sets
`tied_to_next` on every piece but the last, and carries
articulation / ornament / dynamic only on the **first** piece — those
are attack/decay marks that don't carry through a sustained tie. The
last piece preserves the source's original `tied_to_next` so an
already-tied chain stays linked.

Cross-measure moves are subtle about ties: the moved event's original
`tied_to_next` pointed at the event that *followed* it in the source,
which is no longer adjacent after the move. `cloneEventStripTrailingTie`
strips that flag before cascading so the chain's terminal piece doesn't
inherit a dangling tie; inter-piece ties within the cascade are still
set by `decoratePart`. On the source side,
`stripTrailingTieFromLast` clears a predecessor's tie that would
otherwise dangle onto the synthesized rest filler.

### Structural splices + index remap

```
 op.kind = appendMeasures / insertMeasuresAfter / regionReplace / dragMeasureRange
                                   │
              ┌────────────────────┴───────────────────────┐
              ▼                                             ▼
  applyStructuralAppendOrInsert                      applyRegionReplace
  (fan content across every (staff,voice);           (remove [start..end] on every
   missing voices → fillMeasureWithRests)             (staff,voice); inject or rests)
              │                                             │
              ▼                                             ▼
       remapScoreReferences( remapIndexAfterInsert )  remapScoreReferences( remapIndexAfterRegionReplace )
              │                                             │
              ▼                                             ▼
   re-point / drop measureIdx-bearing score-level entries:
   techniqueStates · voltas(both endpoints) · markers · jumpMarkers ·
   segno+coda markers · annotations(target + spanEnd)
   + H3 post-pass: drop jumpMarkers whose segno/coda ref no longer resolves
   + (regionReplace/delete only) dropSeveredAndInteriorSpans
```

Every measure-count-changing op **fans out across all staves AND all
voices** so bars stay aligned. `withAllVoiceMeasures` (in
`editOperations.ts`) and `withAllStaffMeasures` (in `scoreAccessors`)
are the immutable-update primitives. The `perVoiceContent` shape is
`Array<{ voices: Measure[][] }>`: outer index 0 = primary staff,
1 = secondStaff; `voices[0]` = primary voice, `voices[N]` =
`extraVoices[N-1]`. Voices with no supplied content default to
`fillMeasureWithRests` at meter capacity.

`remapScoreReferences` is the single chokepoint that re-points or drops
every score-level `measureIdx` reference. The remapper returns the new
index or `null` to **drop** the entry:

- `remapIndexAfterInsert(idx, afterMeasureIdx, count)` shifts `idx > afterMeasureIdx` by `+count`.
- `remapIndexAfterRegionReplace(idx, start, end, count)` returns the new idx, or `null` to DROP (when `idx` is inside a deleted range with `count===0`). A surviving in-range ref is **pinned to `start + count - 1`** (the last new measure) — a conservative orphan policy, not a true re-anchor.

Voltas keep only if BOTH endpoints remap non-null. After segno/coda
markers are remapped (some may have dropped), an **H3 post-pass** sweeps
`jumpMarkers` and drops any whose `segnoRef` / `codaRef` / `toCodaRef`
no longer resolves — this prevents `validateScore` from throwing
`jump_ref_missing` downstream.

### Spans are event-id based, not measureIdx based

Spans (slurs, hairpins, octave-spans, glissandi, trill-lines,
tempo-spans, tremolo-between, …) reference event **ids**, so
`remapScoreReferences` does **not** touch them. Consequences:

- **insert** leaves spans alone — no shift needed.
- **regionReplace / delete** must explicitly clean spans:
  `detectSeveredSpans` flags spans with one endpoint inside the
  replaced range (the handler emits a warning per id);
  `dropSeveredAndInteriorSpans` drops both severed and
  fully-inside spans (fully-inside ones reference events that no
  longer exist).
- **dragMeasureRange move** preserves event ids (`captureRangeContent`
  carries them verbatim), so spans whose endpoints live in the moved
  range survive automatically.
- **dragMeasureRange duplicate** must mint **fresh** ids
  (`cloneCapturedRangeWithFreshIds`); with original ids on both source
  and copy, span endpoints resolve ambiguously because
  `validateScore`'s `indexEventsById` is last-write-wins, not
  throw-on-collision.
- **measure copy/paste (D4)** carries the spans fully inside the copied
  range and re-anchors them onto the pasted copies. `insertMeasuresAfter`
  and `regionReplace` each take an optional `spansToAdd: Span[]` that
  `transformScore` appends to `Score.spans` **after** the
  interior/severed drop. The clipboard layer captures interior spans
  (`spansFullyInsideRange`), clones the bundle via
  `cloneCapturedRangeWithFreshIdsMapped` (which returns the old→new
  event-id map), then `remapSpansToFreshIds` rewrites endpoints onto the
  fresh ids before they ride along in `spansToAdd`. Spans straddling the
  range boundary are dropped.

### `dragMeasureRange` move bundle

The move mode preserves score-level entries scoped to the source range
and re-anchors them at the destination:

```
extractRangeEntries(score, fromStart, fromEnd)   // pull entries fully inside; warn+drop straddlers
   → stripRangeEntries(...)                       // remove originals
   → applyRegionReplace(..., [], undefined)       // delete the source range (empty replacement)
   → remapScoreReferences(remapIndexAfterRegionReplace(..., count=0))
   → applyStructuralAppendOrInsert(at remappedToAfter)
   → reattachExtractedEntries(extracted, destinationStart)
   → normalizeFinalPartial(...)
```

Voltas and annotations **straddling** the source-range boundary (one
endpoint inside, one outside) are dropped with a warning — their span
semantic can't survive the move. Fully-inside entries are preserved.

### Content-hash diff

`scoreDiff` hashes each **primary-staff / voice-0** measure with
`hashMeasure` = FNV1a over the `canonEvent` join. `canonEvent` is
deliberately **id-free** so a re-emitted measure with fresh uuids but
identical content still counts as "retained". It captures (at
`DIFF_ALGO_VERSION=2`): kind, duration, per-pitch step+octave+
accidental + per-pitch `tied_to_next`, articulations (order-insensitive),
dynamic, ornament, fermata, event-level `tied_to_next`, tuplet,
lyrics (sorted by verse), fingerings, and chordSymbol.

`retainedEventRatio = retained / measureCountBefore` drives the
replacement-as-confirmation gate (an append leaves leading bars
byte-identical → ratio ≈ 1.0; a wholesale rewrite scores near zero).
`computeAffectedEventIds` index-pairs events per measure (NOT id-pairs,
because handlers may re-emit identical measures with fresh uuids) and
emits the AFTER-side ids of changed / inserted events to feed the
amber ghost-preview overlay.

### `smartInsertNote` three-case rest absorption

`scanAbsorbable` totals trailing rests at/after the insertion anchor,
skipping tuplets and tie-protected rests, and **refuses** (returns
`absorbable=0`) when the anchor is a note that ties forward — splicing
between a tied note and its sustain target would sever the tie.

| Case | Condition | Result |
|---|---|---|
| 1 absorb-fit | `absorbable >= requested` | replace the rest region with note + leftover rests |
| 2 shrink-to-fit | `absorbable >= sixteenth` | insert a smaller note sized to `absorbable`; emit a status message |
| 3 spillover | otherwise | inject a brand-new bar fanned across all staves+voices (`fillMeasureWithRests`), padded to meter capacity so it stays valid; the active (staff,voice) gets `[note, …padding rests]` |

All three return a fresh `Selection` so the editor re-targets the
inserted note.

### `pasteEvents` clipboard event-run paste

`pasteEvents(score, target, events)` is the paste primitive behind the
context-menu Paste row (clipboard layer lives in `lib/chat/clipboard.ts`;
see the editor-ui card). It deep-clones the run with **fresh ids**
(`withFreshIds`) so pasted events never share identity with the
clipboard entry, then:

| Case | Condition | Result |
|---|---|---|
| 1 absorb-fit | run units ≤ contiguous rest space at the anchor | splice into this bar + pad leftover; mirrors `smartInsertNote.scanAbsorbable` (a tied / tuplet rest stops the scan) |
| 2 spill | otherwise | `packEventsIntoMeasures` tie-splits (`tieSplitOver`) the run across new meter-valid bars, fans rest measures across every other staff/voice to stay bar-aligned, and inserts them after the destination bar |

Only a **tuplet straddling a barline** is refused — `packEventsIntoMeasures`
re-throws the `BalanceError` and `pasteEvents` returns `{ ok: false }`
with a status message and **no mutation**. `pasteEvents` never produces
an over-full (invalid) bar. Returns `PasteEventsResult { ok, score,
newSelection?, statusMessage? }`. (Whole-*measure* paste is a separate
path: `pasteMeasuresInsertOp` / `pasteMeasuresReplaceOp` build
`insertMeasuresAfter` / `regionReplace` ops from a captured bundle, with
D4 span-carry — see Spans above.)

### `buildEventTimeIndex` (the outlier)

This one does not transform a Score. It consumes abcjs render timing
(`visualObj.setupEvents()`) and resolves each event's `startChar` back
through the `SourceMap` (`resolveClickPosition`) to a
`${staff}:${voice}:${measure}:${event}` key → milliseconds, for synth
seeking. It uses the **earliest** ms per position to dedupe chord notes
(which emit duplicate timing events).

## Invariants & gotchas

- **`transformScore` does NOT validate.** Only `applyOperation` runs `validateScore`. Callers that compose multiple ops can hold transiently-invalid Scores; validation must happen at the boundary, not after each op.
- **Clear/preserve conventions vary by op family and are load-bearing.** Optional event-field setters *strip the key* when cleared (keeps persisted JSON clean and lets back-compat fallbacks like legacy `ornament:'grace'` re-appear as the renderer's fallback). Setting a barline/anacrusis flag to its default also strips. Read the op's comment before changing — `undefined`=preserve vs `null`=clear differs across families.
- **Tuplets are atomic everywhere.** `tieSplitOver` / `tieSplitEvent` throw `tuplet_unsplittable`; `consumeForRoom` refuses with `blocked:'tuplet'`; `reorderBalanced` / `changeDurationBalanced` / `removeBalanced` reject tuplet members; `mergeAdjacentRests` won't merge across a tuplet boundary. Never split or partially consume a tuplet group.
- **Tie-cascade is capped at `MAX_CASCADE_DEPTH=2`** (3 measures total) to stop a pathological long note rippling across the whole score; exceeding it throws `cascade_overflow`.
- **`isFinalPartial` bookkeeping is subtle.** `appendMeasures` clears it on the old last bar; `applyRegionReplace` transfers it onto the replacement's last bar **only when `newCount>0`**; `dragMeasureRange` delete/move call `normalizeFinalPartial` to relocate it because the regionReplace-empty path (`newCount===0`) skips the transfer and a moved final bar would otherwise strand the flag mid-score.
- **Spans are event-id based, NOT measureIdx based** (see above). Insert leaves them alone; regionReplace/delete must drop severed/interior spans; duplicate must mint fresh ids.
- **`dragMeasureRange` shares ONE `case 'dragMeasureRange'` label** for delete/move/duplicate. Mode branches are `if (op.mode === …)` guards, **not** a discriminated switch — a new mode that forgets its `if` branch silently falls through into the move block. An explicit code comment at `editOperations.ts:1801` warns about this.
- **`remapIndexAfterRegionReplace` returning `null` means DROP.** Surviving in-range refs are pinned to the last new measure (`start + count - 1`), a conservative orphan policy.
- **`scoreDiff` / `canonEvent` are id-free and hash ONLY primary-staff / voice-0 measures.** `retainedEventRatio` and `computeAffectedEventIds` ignore second-staff and extra-voice changes. An empty `pitches[]` is treated as an explicit rest marker so both rest representations (`kind:'rest'` vs `pitches:[{step:'rest'}]`) hash to the same canonical form.
- **`smartInsertNote` refuses to absorb a rest carrying `tied_to_next`** or to insert between a tied note and its sustain target — it falls back to spillover to avoid severing the tie.
- **`mergeAdjacentRests` is conservative first-wins.** It won't merge across tuplet boundaries or ties, leaves non-representable sums unmerged (e.g. dotted-eighth + eighth = 10 units), and keeps the FIRST rest's metadata.
- **`buildEventTimeIndex` is the odd one out** — it transforms no Score; it consumes abcjs render output + the SourceMap.
- **Clamps throw or silently truncate rather than defer to schema validation.** Octave transposition (`changePitch`) clamps to octaves 2..6; `addPitchToChord` caps at 6 pitches; `changeTempo` clamps 30..240 bpm (throws outside); `changeTitle` truncates to 80 chars.
- **`deleteEvent` on a measure's ONLY event converts it to a same-duration rest in place** (id preserved so span/tie endpoints stay anchored) — it does **not** throw. (It used to throw `EditError('Cannot delete the only event in a measure')`, which aborted the whole edit and fell through to the slow legacy path; #245 replaced that.) `removeBalanced` still rejects the last-event-in-a-measure *move* with `would_empty_measure`.

## How to extend / common tasks

**Add a new event-level op (e.g. a new marking).** Add a variant to the
`Operation` union, then a `case` to the `transformScore` switch that
uses `withEvent` / `withPitch`. Follow the existing clear/preserve
convention: strip the key on clear. Add a test file
`tests/unit/music/editOperations.<feature>.test.ts`.

**Add a new `dragMeasureRange` mode.** Add the variant to the union,
then add an `if (op.mode === '<new>')` branch **before** the move
fallthrough in the shared `case 'dragMeasureRange'` (the comment at
`editOperations.ts:1801` explains why). Decide its span and
score-level-entry policy explicitly: move-like (preserve ids,
extract/reattach) vs duplicate-like (mint fresh ids, don't carry
entries). Re-use `captureRangeContent` / `applyStructuralAppendOrInsert`
/ `remapScoreReferences` rather than open-coding the fanout.

**Add a new score-level entry type that carries a `measureIdx`.** Wire
it into `remapScoreReferences`, `extractRangeEntries`,
`stripRangeEntries`, and `reattachExtractedEntries` — all four, or the
move/delete paths will leave it stale. If it references another entry
by id (like jumpMarkers→segno), add a dangling-ref post-pass mirroring
the H3 sweep.

**Add a new field to the retention hash.** Bump `DIFF_ALGO_VERSION`
(persisted alongside each `orchestrator_turns` row so replay tools know
which rows are comparable) and extend `canonEvent`. Keep it id-free.

**Add a balanced edit.** Build on the `measureBalance` primitives
(`consumeForRoom`, `tieSplitOver`, `fillWithRests`,
`mergeAdjacentRests`) so the result stays meter-valid; throw
`BalanceError` with the appropriate UX-toast `code` on any
unbalanceable case rather than producing an invalid Score.

## Testing

| Area | Test |
|---|---|
| Core transform / addressing | `tests/unit/music/editOperations.test.ts` |
| Structural splices + remap | `tests/unit/music/editOperations.appendMeasures.test.ts`, `.regionReplace.test.ts`, `.dragMeasureRange.test.ts`, `tests/unit/music/structuralOps.test.ts` |
| Per-op-family | `tests/unit/music/editOperations.{reorder,perNoteMarkings,barlines,techniques,markers,annotations,voltas,jumpMarkers,hairpins,slurs,tempoSpans,octaveSpans,glissando,trillLine,tremoloBetween,lyrics,fingerings,chordSymbols}.test.ts` |
| 32nd arithmetic | `tests/unit/music/measureBalance.test.ts` |
| Balanced ops + cross-measure cascade | `tests/unit/music/transformScoreBalanced.test.ts`, `tests/unit/music/reorderBalanced.crossMeasure.test.ts` |
| Note entry | `tests/unit/music/smartInsertNote.test.ts`, `smartInsertNote.voice.test.ts` |
| Clipboard event-run paste | `tests/unit/lib/music/pasteEvents.test.ts` |
| Measure copy/paste span-carry (D4) | `tests/unit/music/spanCarry.test.ts` |
| Fanout bar-alignment | `tests/unit/music/addStaff.barAligned.test.ts` |
| Diff / hash / affected-ids | `src/lib/music/scoreDiff.test.ts` |
| Timing index | `tests/unit/music/buildEventTimeIndex.test.ts` |
| Editor-state integration | `tests/unit/chat/state.applyBalancedEdit.test.ts`, `tests/unit/chat/state.measureRangeSelection.test.ts` |

## Related files / See also

- `src/lib/music/scoreAccessors.ts` — `withVoiceMeasures` / `withAllStaffMeasures` / `getVoiceMeasures` / `getStaffCount` / `getVoiceCount` (the immutable-update + read primitives).
- `src/lib/music/meter.ts` — `meterCapacityIn32nds` (meter → 32nd capacity).
- `src/lib/music/validateScore.ts` — the schema + semantic validator `applyOperation` defers to.
- `src/lib/music/spans.ts` — span kind guards + `JUMP_KINDS` (the span/jump vocabulary the ops manipulate).
- `src/lib/music/scoreToAbcWithMap.ts` — `SourceMap` + `resolveClickPosition` consumed by `buildEventTimeIndex`.
- `src/lib/orchestrator/README.md` — how the orchestrator dispatches edit-ops, runs preservation-verify (`scoreDiff`), and gates replacements.
- `src/lib/music/types.ts` — the `Score` data model these transforms operate on.
