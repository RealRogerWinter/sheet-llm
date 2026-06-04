---
title: Adding an Edit Operation
subsystem: edit-operations
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/editOperations.ts
  - src/lib/music/structuralOps.ts
  - src/lib/music/transformScoreBalanced.ts
  - src/lib/music/validateScore.ts
  - src/lib/music/scoreAccessors.ts
  - src/lib/orchestrator/handlers/editIntraMeasure.ts
  - src/lib/orchestrator/summarizeAction.ts
  - src/lib/chat/state.ts
  - src/components/editor/keyboardShortcuts.ts
  - src/components/editor/useEditorKeyboard.ts
related:
  - edit-operations
  - music-model
  - orchestrator
  - chat-session
---

# Adding an Edit Operation

This is the recipe for adding a new **pure edit operation** to the
`Operation` vocabulary in
[`src/lib/music/editOperations.ts`](../../src/lib/music/editOperations.ts).
An `Operation` is one immutable Score→Score transform. The same op is
emitted by the LLM (via the `edit_score` tool), by keyboard shortcuts,
and by popover/palette UI — so getting the shape right means it works
everywhere at once.

Read the existing subsystem reference first:
[`docs/subsystems/edit-operations.md`](../subsystems/edit-operations.md).
This guide is the *how-to*; that doc is the *what-exists*.

---

## The mental model

```
Operation (discriminated union, .kind tag)
        │
        ▼
transformScore(score, op)        ← pure, NO validation; throws EditError on hard impossibility
        │
        ├─ applyOperation(score, op)        = transformScore + validateScore (throws on invalid result)
        │
        └─ used directly where temporarily-invalid intermediate states are OK
```

Two entry points, both exported from `editOperations.ts`:

| Function | Validates? | Used by |
| --- | --- | --- |
| `transformScore(score, op)` | No (only `EditError` for hard impossibilities) | client store `applyEdit`, intra-measure handler loop |
| `applyOperation(score, op)` | Yes — runs `validateScore`, re-throws as `EditError` | callers that want an all-or-nothing valid result |

The split is deliberate. The client store
([`src/lib/chat/state.ts`](../../src/lib/chat/state.ts) `applyEdit`,
~L1365) applies `transformScore` *without* validation so a momentarily
unbalanced measure (e.g. mid-edit, 5 quarters in 4/4) is allowed; the
LLM repairs it on the next turn. The orchestrator handler
([`src/lib/orchestrator/handlers/editIntraMeasure.ts`](../../src/lib/orchestrator/handlers/editIntraMeasure.ts)
~L1216) runs `transformScore` per-op then `validateScore` once at the
end so it can retry the whole batch on a validation failure.

> **Invariant:** `transformScore` is pure. It returns a new Score and
> never mutates `score`. Every branch goes through the immutable
> accessor helpers (`withEvent`, `withVoiceMeasure`, `withAllStaffMeasures`,
> …) which spread-copy down the tree. Do not reach into
> `score.measures[i].events[j]` and assign.

---

## Where things live

| Concern | File / symbol |
| --- | --- |
| The `Operation` union | `editOperations.ts:Operation` (~L98) |
| The dispatcher | `editOperations.ts:transformScore` (~L940) |
| Validated wrapper | `editOperations.ts:applyOperation` (~L3910) |
| `EditError` class | `editOperations.ts:EditError` (~L730) |
| `Target` tuple | `editOperations.ts:Target` (~L90) |
| Multi-measure splice helpers | [`src/lib/music/structuralOps.ts`](../../src/lib/music/structuralOps.ts) |
| Balance-aware variants | [`src/lib/music/transformScoreBalanced.ts`](../../src/lib/music/transformScoreBalanced.ts) |
| Semantic validation | [`src/lib/music/validateScore.ts`](../../src/lib/music/validateScore.ts) |
| Sanctioned measure access | [`src/lib/music/scoreAccessors.ts`](../../src/lib/music/scoreAccessors.ts) |

---

## The shape of an op

Most ops carry a `Target` and address a single event or pitch:

```ts
export type Target = {
  staffIdx?: number   // default 0
  voiceIdx?: number   // default 0
  measureIdx: number
  eventIdx: number
  pitchIdx?: number   // default 0 for per-pitch ops
}
```

`staffIdx` / `voiceIdx` default to `0` so legacy single-staff
single-voice edits keep working unchanged (`staffOf` / `voiceOf` at
~L760). **Never** index `score.measures` directly for a targeted op —
go through the helpers so multi-staff / multi-voice scores resolve
correctly:

| Helper (in `editOperations.ts`) | What it does |
| --- | --- |
| `getEvent(score, target)` | resolves the `Event` or throws `EditError` |
| `withEvent(score, target, mapper)` | immutably rewrites one event |
| `withPitch(score, target, mapper)` | immutably rewrites one pitch; **bounds-checks `pitchIdx`** |
| `withVoiceMeasure(...)` | immutably rewrites one measure in one voice |
| `withMeasure(...)` | rewrites one measure on a staff (voice-blind, measure-level ops) |
| `withAllStaffMeasures(...)` | fan-out across every staff (keeps staves bar-aligned) |

These delegate to the accessor layer in `scoreAccessors.ts`
(`getVoiceMeasureAt`, `withVoiceMeasures`, `withStaffMeasures`,
`withAllStaffMeasures`, …) — the **only** sanctioned way to reach the
measure lists, because the Score schema stores the primary voice inline
on `score.measures` but extra voices under `score.extraVoices[].measures`
and the second staff under `score.secondStaff`. The accessors hide that
shape so your op doesn't have to special-case it.

### EditError is the retry signal

Throw `EditError` (not a bare `Error`) for anything the caller — or the
LLM — could plausibly correct: out-of-range index, "can't delete the
only event", "octave out of range". The retry pipeline embeds the
`EditError.message` verbatim into the next LLM turn, so make the message
**specific and actionable** (name the index, the bound, the reason).
See `assertVoiceExists` (~L774) and `assertStaffExists` (~L797) for the
house style.

> **Footgun — silent no-ops.** If your mapper walks an array with
> `.map` but the target index is out of range, the event is rebuilt
> *unchanged*, `validateScore` passes, and the handler reports success
> despite no edit. That gives the LLM no signal to retry. `withPitch`
> (~L909) guards against exactly this — copy its pattern: bounds-check
> and throw `EditError` *before* the no-op can happen.

### Clearing optional fields

For optional event-level fields, the convention (M2-PR-3) is: pass the
value to **set**, omit to **clear**, and have the transform *strip the
key* when clearing (destructure-and-drop) rather than store
`undefined`. This keeps persisted JSON clean and keeps back-compat
read helpers from seeing `undefined`. Booleans use *false-to-clear*
(`setPitchTie`, `setLv`, …). See `setArticulations` (~L1274) for the
canonical strip pattern.

---

## Checklist: a simple per-event op

1. **Add the variant** to the `Operation` union (~L98). Put a comment
   block above it documenting WHY (the union is the spec the LLM reads
   via the tool schema). Include the milestone tag if relevant.
2. **Add a `case` to `transformScore`** (~L940). Assign `next` and
   `break` — every case sets the single `let next: Score` declared at
   the top and falls through to the shared `return next` (~L3520). Do
   not early-`return`.
3. **Use the accessor helpers**, not raw indexing. Throw `EditError`
   with a specific message on any addressable failure.
4. **Decide validation strength.** If the op can produce a
   temporarily-invalid-but-recoverable state, leave it to the caller
   (most per-marking ops do). If it must always land valid, the
   relevant invariant is enforced by `validateScore` /
   `validateCrossRefs` at save time regardless — but consider an
   explicit guard in the op for a better error message.
5. **`summarizeAction`** — add a `case` in
   [`src/lib/orchestrator/summarizeAction.ts`](../../src/lib/orchestrator/summarizeAction.ts)
   (~L42+) so the op produces a human "what changed" string for the
   chat transcript. Missing cases fall back to a generic aggregate.
6. **Wire the LLM** if the model should emit it: the intra-measure tool
   accepts *any* op shape (`EditScoreInputSchema = z.object({ ops:
   z.array(z.unknown()) })`, `editIntraMeasure.ts` ~L395) — the JSON
   Schema in `buildEditScoreSchemaJson` (~L397) is advisory only;
   real enforcement is `transformScore` throwing `EditError`. To make
   the model *reliably* emit your op, document it in
   `INTRA_SYSTEM_PROMPT` (~L43).
7. **Wire the UI** if a human triggers it (keyboard / popover / palette
   — see [Invocation surfaces](#invocation-surfaces)).
8. **Tests** — add `tests/unit/music/editOperations.<feature>.test.ts`
   (see [Where tests go](#where-tests-go)).

### Worked example — `setStaccatissimo`

A minimal boolean per-event op, modeled on `setBreathMark` (~L154) and
the strip-on-clear idiom.

```ts
// 1) In the Operation union (editOperations.ts ~L98):
| { kind: 'setStaccatissimo'; target: Target; staccatissimo: boolean }
```

```ts
// 2) In transformScore's switch (editOperations.ts ~L940):
case 'setStaccatissimo': {
  next = withEvent(score, op.target, (e) => {
    if (e.pitches.some((p) => p.step === 'rest')) {
      // EditError → fed back to the LLM / surfaced as a UI toast.
      throw new EditError('Cannot put staccatissimo on a rest')
    }
    if (!op.staccatissimo) {
      // false-to-clear: strip the key so persisted JSON stays clean.
      const { staccatissimo: _drop, ...rest } = e
      void _drop
      return rest as Event
    }
    return { ...e, staccatissimo: true }
  })
  break
}
```

```ts
// 5) In summarizeAction.ts:
case 'setStaccatissimo':
  return op.staccatissimo ? 'Added staccatissimo' : 'Removed staccatissimo'
```

The `staccatissimo` field must also exist on `EventSchema` in
[`src/lib/music/types.ts`](../../src/lib/music/types.ts) (this guide
covers the op; the schema field is a music-model change — see
[`docs/subsystems/music-model.md`](../subsystems/music-model.md)).
`validateScore` will reject any field not declared on the schema, so
the schema edit and the op land together.

---

## Structural ops (multi-measure) are different

Ops that add / remove / replace whole measures —
`appendMeasures`, `insertMeasuresAfter`, `regionReplace`,
`dragMeasureRange` (~L633–L723) — carry **two** extra burdens that
per-event ops don't:

1. **Per-voice fanout.** Every staff and every voice must stay
   bar-aligned. You splice the LLM-supplied measures into the primary
   voice and fill *every other* voice with meter-sized rests (or
   supplied `perVoiceContent`). The shared helper is
   `applyStructuralAppendOrInsert` (~L3561); region replace uses
   `applyRegionReplace`. Both fan out via `score.extraVoices`,
   `score.secondStaff`, and `secondStaff.extraVoices`.

2. **Index remapping.** Score-level entries store a `measureIdx`
   (or `startMeasureIdx`/`endMeasureIdx`): `techniqueStates`, `voltas`,
   `markers`, `jumpMarkers`, `segnoMarkers`, `codaMarkers`,
   `annotations`. After you shift measures, those indices must move too,
   or they'll point at the wrong bar. This is the job of
   [`structuralOps.ts`](../../src/lib/music/structuralOps.ts):

| Helper | Use |
| --- | --- |
| `remapIndexAfterInsert(idx, afterIdx, count)` | indices > `afterIdx` shift `+count` |
| `remapIndexAfterRegionReplace(idx, start, end, count)` | returns `null` for entries inside a deleted range (caller drops them) |
| `remapScoreReferences(score, remap, warnings?)` | applies a remapper to **every** score-level structure; drops entries whose remap returns `null`; also sweeps `jumpMarkers` for now-dangling `segnoRef`/`codaRef`/`toCodaRef` (prevents `jump_ref_missing` at validate time) |

   Spans are **event-id based**, not index based, so inserts/appends
   don't touch them. But `regionReplace` *can* sever a span whose
   endpoints straddle the replaced range — use
   `detectSeveredSpans` (to warn) and `dropSeveredAndInteriorSpans`
   (to clean) (~L659, ~L702). For range *moves* there is a separate
   extract/strip/reattach trio (`extractRangeEntries`,
   `stripRangeEntries`, `reattachExtractedEntries`, ~L328+) that carries
   fully-inside score-level entries to the destination and **drops
   straddlers with a warning**.

> **Exhaustiveness footgun (`dragMeasureRange`).** All three modes
> (`delete` / `move` / `duplicate`) share one `case 'dragMeasureRange'`
> label, so TypeScript does *not* check mode-exhaustiveness. A new mode
> MUST add an `if (op.mode === '<new>') { … break }` branch *before*
> the `move` fallthrough, or it silently runs the move path. The code
> calls this out inline (~L1804).

If your op is structural, the checklist gains: pick/extend a remap
helper, run `remapScoreReferences`, handle span severance, and add a
fanout path for `perVoiceContent`.

---

## Balanced (meter-aware) ops

For *user-driven* edits where the result must always sum to the meter
(drag-to-reorder, resize a note, delete-and-backfill), there is a
parallel vocabulary in
[`transformScoreBalanced.ts`](../../src/lib/music/transformScoreBalanced.ts):
`reorderBalanced`, `changeDurationBalanced`, `removeBalanced`. These
do rest-fill, tie-cascade across measures, and tuplet-group protection,
and throw a `BalanceError` (with a discriminated `code` for UX toasts)
instead of `EditError`.

Add a balanced op here when the operation is meaningless without
keeping the measure full — otherwise add a plain `Operation`. The two
families are independent unions; the client store has separate actions
(`applyEdit` vs `applyBalancedEdit`).

---

## Invocation surfaces

The same op can be reached three ways. Wire the ones your op needs.

```
                    ┌──────────────────────────────────────┐
   LLM ── edit_score tool ──▶ editIntraMeasure handler      │
                    │   transformScore per-op + validateScore once  (with retry)
                    │                                        │
   Keyboard ── mapKey() ──▶ store.applyEdit ──▶ transformScore (no validate)
                    │                  └─ store.applyBalancedEdit ──▶ transformScoreBalanced
                    │                                        │
   Popover/Palette ──▶ store.applyEdit / applyBalancedEdit ─┘
                    └──────────────────────────────────────┘
```

| Surface | Entry | Notes |
| --- | --- | --- |
| **Orchestrator** | `editIntraMeasure.ts` apply loop (~L1216) | LLM emits an `ops` array; handler runs `transformScore` per op, then one `validateScore`, retrying on `ValidationError` (≤2 attempts). To make the model emit your op, extend `INTRA_SYSTEM_PROMPT`. |
| **Keyboard** | `keyboardShortcuts.ts:mapKey` (~L114) returns `ShortcutResult = { op, coalesce? } \| StoreAction \| null`; consumed by `useEditorKeyboard.ts` (~L56) which routes to `applyEdit` or `applyBalancedEdit` | `coalesce` keys merge rapid repeats into one undo entry. |
| **Editor UI / palette** | `store.applyEdit(op, coalesceKey?)` / `store.applyBalancedEdit(...)` in `state.ts` (~L1365, ~L1455) | Catches `EditError`/`BalanceError` → user-facing toast; pushes undo history; re-renders ABC; interrupts any pending AI ghost proposal. Popovers (`NoteFloatingMenu.tsx`) call these directly. |

The client store path (`applyEdit`) also: pings audio on `changePitch`,
shows an undo toast via `humanLabelFor(op)` (~L905 — add a label for
your op so the toast isn't blank), coalesces history, and re-renders
via `renderWithMap`. See
[`docs/subsystems/chat-session.md`](../subsystems/chat-session.md).

---

## Where tests go

Per-feature spec files live in `tests/unit/music/`, one per op family
(e.g. `editOperations.barlines.test.ts`,
`editOperations.dragMeasureRange.test.ts`,
`editOperations.appendMeasures.test.ts`). Add a new file
`editOperations.<feature>.test.ts` for a new family, or extend an
existing one. The remap/splice primitives have their own suite at
`tests/unit/music/structuralOps.test.ts`.

Cover at minimum:

- **Happy path** — op produces the expected Score (assert the exact
  field, not just "no throw").
- **Immutability** — the input Score is unchanged after the call.
- **`EditError` cases** — every addressable failure throws with a
  message (out-of-range index, "only event/pitch/measure", rest
  guards). These messages are the LLM's retry signal; assert on them.
- **`applyOperation` integration** — the result passes `validateScore`
  (or, for intentionally-invalid intermediate states, that
  `transformScore` allows it while `applyOperation` rejects it).
- **Structural ops only** — index remap of every score-level entry
  type, per-voice fanout (multi-staff + extra-voice fixtures), and span
  severance/preservation.
- **Balanced ops only** — measure totals still equal meter capacity;
  tuplet groups are protected; `BalanceError.code` is correct.

Ignore any matches under `.claude/worktrees/` — those are stale
worktree copies, not the live suite.

---

## See also

- [`docs/subsystems/edit-operations.md`](../subsystems/edit-operations.md) — the op vocabulary reference
- [`docs/subsystems/music-model.md`](../subsystems/music-model.md) — Score schema + `validateScore` invariants
- [`docs/subsystems/orchestrator.md`](../subsystems/orchestrator.md) — how the LLM dispatches to handlers
- [`docs/subsystems/chat-session.md`](../subsystems/chat-session.md) — the client store, undo history, ghost-preview interrupt
- [`src/lib/music/editOperations.ts`](../../src/lib/music/editOperations.ts) — `Operation`, `transformScore`, `applyOperation`, `EditError`
- [`src/lib/music/structuralOps.ts`](../../src/lib/music/structuralOps.ts) — remap + splice primitives
- [`src/lib/music/transformScoreBalanced.ts`](../../src/lib/music/transformScoreBalanced.ts) — meter-aware ops + `BalanceError`
- [`src/lib/orchestrator/handlers/editIntraMeasure.ts`](../../src/lib/orchestrator/handlers/editIntraMeasure.ts) — the LLM apply loop + retry
