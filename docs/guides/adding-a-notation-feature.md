---
title: Adding a Notation Feature (End-to-End Recipe)
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/types.ts
  - src/lib/music/ornaments.ts
  - src/lib/music/scoreToAbcWithMap.ts
  - src/lib/music/editOperations.ts
  - src/lib/llm/renderScoreTool.ts
  - src/lib/music/export/musicxml.ts
  - src/components/editor/OrnamentMenuPopover.tsx
  - src/components/editor/NoteFloatingMenu.tsx
  - src/components/editor/commandCatalog.ts
  - src/lib/orchestrator/summarizeAction.ts
  - src/lib/music/spans.ts
  - tests/unit/llm/renderScoreTool.test.ts
related:
  - music-model
  - edit-operations
  - abc-rendering
  - command-palette
  - editor-ui
  - export
---

# Adding a Notation Feature (End-to-End Recipe)

A notation feature in sheet-llm is not one change — it is a value that
has to appear consistently on **every surface** that touches the Score
model. The Score is a single Zod tree
(`src/lib/music/types.ts:ScoreSchema`), but the *facts* about a feature
(its enum values, its render glyph, its edit op, its LLM wire schema,
its MusicXML mapping) are duplicated across ~8 hand-maintained
surfaces. Adding a value to one and forgetting another is the
single most common class of bug in this codebase — so the architecture
leans on **sync-pin tests** (see step 9) to make a forgotten surface
fail loudly in the test suite instead of silently dropping a glyph at render time.

This guide walks the full checklist with one concrete worked example:
**adding a new ornament value, `haydn-ornament`** (a hypothetical
combined-turn glyph), to the existing `Event.ornament` field. Substitute
your own feature; the touch-points are the same.

> **Before you start:** read [`../subsystems/music-model.md`](../subsystems/music-model.md)
> for the Score tree shape and [`../subsystems/edit-operations.md`](../subsystems/edit-operations.md)
> for the edit-op vocabulary. The `ornament` field is a good template
> because it already spans all 9 steps below.

## The surface map

| # | Surface | File | What lives here |
|---|---------|------|-----------------|
| 1 | Zod schema + inferred type | `src/lib/music/types.ts` | `OrnamentSchema` enum + `export type Ornament` |
| 2 | Helpers (legacy/structured split) | `src/lib/music/ornaments.ts` | `isTrillFamilyOrnament`, `TRILL_FAMILY_ORNAMENTS` |
| 3 | ABC emission | `src/lib/music/scoreToAbcWithMap.ts` | `ornamentToAbc()` glyph mapping |
| 4 | abcjs render | `src/lib/abc/synth.ts` (via `render.ts`) | nothing per-feature — generic ABC→SVG |
| 5a | Edit op | `src/lib/music/editOperations.ts` | `setOrnament` op + `transformScore` case |
| 5b | Editor popover | `src/components/editor/OrnamentMenuPopover.tsx` + `NoteFloatingMenu.tsx` | UI cells + op dispatch |
| 5c | Command catalog | `src/components/editor/commandCatalog.ts` | `open-ornament` palette entry |
| 5d | Action summary | `src/lib/orchestrator/summarizeAction.ts` | `setOrnament` human-readable label |
| 6 | LLM tool schema | `src/lib/llm/renderScoreTool.ts` | `ORNAMENT_ENUM` + `ornament` property |
| 7 | MusicXML export | `src/lib/music/export/musicxml.ts` | format mapping |
| 8 | Tests + factory | `tests/unit/music/ornaments.test.ts`, `tests/unit/llm/renderScoreTool.test.ts` | unit + sync-pin |

ASCII of the data flow a single ornament value rides:

```
 user/LLM intent
      │
      ▼
 renderScoreTool.ts (ORNAMENT_ENUM) ──┐  (step 6: LLM authors it)
 OrnamentMenuPopover  ────────────────┤  (step 5b: user clicks it)
      │                               │
      ▼                               ▼
 editOperations.ts setOrnament ──► transformScore ──► Score row
      │                                                  │
      │                          validateScore (step 1 enum gate)
      ▼                                                  │
 scoreToAbcWithMap.ornamentToAbc ◄───────────────────────┘
      │                          musicxml.ts (step 7: export)
      ▼
 abcjs renderAbc (step 4) → SVG glyph
```

---

## Step 1 — Extend the Zod schema and export the type

`src/lib/music/types.ts` is the single source of truth for the shape.
Add the value to the enum; the inferred type at the bottom of the file
picks it up automatically.

```ts
// src/lib/music/types.ts — OrnamentSchema (currently ~L91)
export const OrnamentSchema = z.enum([
  'trill',
  'pralltriller',
  // ...
  'grace',
  'haydn-ornament',   // ← new value
  'none',
])
```

The type re-export already exists near the bottom of the file
(`src/lib/music/types.ts`):

```ts
export type Ornament = z.infer<typeof OrnamentSchema>
```

If you are adding a **new field** (not a new enum value), add it to
`EventSchema` (`src/lib/music/types.ts:EventSchema`, ~L519) *and* add a
matching `export type X = z.infer<typeof XSchema>` line. Make new fields
`.optional()` — the schema follows a **Phase-1 additive-rollout**
invariant: every extension is optional so legacy stored Scores still
parse. (See the `id` / `kind` optional-during-rollout comments at
`src/lib/music/types.ts:EventIdSchema` / `EventKindSchema`.)

Validation flows through one entry point,
`src/lib/music/validateScore.ts:validateScore` (L107), which parses
against `ScoreSchema` and then runs the cross-reference invariants in
`src/lib/music/validateCrossRefs.ts:validateCrossRefs` (L23). A bad
enum value is rejected by the Zod parse; structural invariants (span
endpoints exist, jump refs resolve, voltas consecutive) live in
`validateCrossRefs`. **You do not need to touch `validateScore` for a
new enum value** — the enum is the gate. You *do* touch
`validateCrossRefs` only if your feature introduces a new
cross-reference (e.g. a new id-linked marker family).

## Step 2 — Add helpers if there is a legacy/structured split

Several features carry a **legacy singular** field plus a **structured
plural/object** field, with a helper module unifying the read path so
the rest of the code never branches on which form is present:

| Feature | Legacy field | Structured field | Helper module |
|---------|--------------|------------------|---------------|
| articulations | `Event.articulation` | `Event.articulations[]` | `src/lib/music/articulations.ts` (`getArticulations`) |
| dynamics | `Event.dynamic` | `Event.dynamic_structured` | `src/lib/music/dynamics.ts` |
| grace notes | `Event.ornament: 'grace'` | `Event.graceNotes[]` | rendered in `scoreToAbcWithMap.ts` |
| ties | `Event.tied_to_next` | `Pitch.tied_to_next` | `src/lib/music/pitchTies.ts` |
| ornaments (trill family) | — | `Event.trillUpperPitch` | `src/lib/music/ornaments.ts` |

For our example, the ornament helper is
`src/lib/music/ornaments.ts`. It exports `TRILL_FAMILY_ORNAMENTS` and
`isTrillFamilyOrnament()` — the set of ornaments that accept a
`trillUpperPitch` accidental. If `haydn-ornament` accepts a trill
accidental, add it to that array (one place, consumed by the popover at
`OrnamentMenuPopover.tsx:119` and by `NoteFloatingMenu.tsx`'s
auto-clear logic). If your feature has no such split, skip this step.

> **Invariant the helpers protect:** read-path callers must never
> inspect both the legacy and structured field independently — they go
> through the helper, which decides precedence. The renderer encodes
> this precedence directly: at `scoreToAbcWithMap.ts` (~L1683) a present
> + non-empty `graceNotes` array *suppresses* the legacy
> `ornament: 'grace'` glyph.

## Step 3 — Emit it in the Score→ABC transpiler

The canonical transpiler is
`src/lib/music/scoreToAbcWithMap.ts` — it produces ABC **plus** the
character-range `SourceMap` that links Score events to ABC chars (and
through `data-startchar` to rendered SVG noteheads). `scoreToAbc.ts` is
the thin map-less variant; **emit your glyph in
`scoreToAbcWithMap.ts`** (it is what the editor actually renders) and
keep `scoreToAbc.ts` consistent if it has a parallel path.

Ornaments are mapped by `ornamentToAbc()` at
`src/lib/music/scoreToAbcWithMap.ts:129`:

```ts
function ornamentToAbc(orn?: Ornament): string {
  switch (orn) {
    case 'trill': return 'T'
    case 'pralltriller': return '!pralltriller!'
    // ...
    case 'haydn-ornament': return '!turn!'   // ← nearest abcjs glyph
    default: return ''
  }
}
```

**Gotcha — abcjs has a fixed decoration vocabulary.** The legal
decoration tokens come from abcjs's `legalAccents` list
(`node_modules/abcjs/dist/abcjs-basic.js`). If abcjs has no glyph for
your feature, map to the *nearest visually-similar* token and record
the lossy mapping in a comment — exactly as
`ornamentToAbc` does for `schneller → !pralltriller!`,
`delayed-turn → !turn!`, and `non-arpeggio → ''` (renders nothing).
The Score still stores the precise intent; only the render is
approximate until a follow-up PR adds a custom glyph. **A `default:
return ''` that silently drops an unknown value is a footgun** — the
sync-pin tests in step 9 exist precisely to catch a new enum value
that never got a `case`.

The transpiler call exit point is
`scoreToAbcWithMap.ts:scoreToAbcWithMap()`; clicks round-trip back
through `resolveClickPosition()` and
`src/components/editor/useNoteClickHandler.ts`. See
[`../subsystems/abc-rendering.md`](../subsystems/abc-rendering.md).

## Step 4 — Render via abcjs

There is **no per-feature work** here. `src/lib/abc/render.ts` is a
3-line dynamic-import wrapper around `abcjs.renderAbc`, and the renderer
the editor actually uses is `src/lib/abc/synth.ts:renderScore()` (L94),
which calls `abcjs.renderAbc` and wires the synth/timing callbacks. Once
your ABC token is in the legal-accents vocabulary (step 3), abcjs draws
it. If the glyph does *not* appear, the problem is your token in step 3,
not the renderer.

## Step 5 — Wire an edit operation, a popover, the palette, and the summary

This is four sub-surfaces. Skipping any one leaves the feature
unreachable from some entry point.

### 5a — Edit op (`src/lib/music/editOperations.ts`)

For an existing field + new enum value, **no new op is needed** — the
`setOrnament` op already carries any `Ornament`:

```ts
// editOperations.ts — Operation union (~L127)
| { kind: 'setOrnament'; target: Target; ornament: Ornament }
```

…with the transform case at `editOperations.ts` (~L1301):

```ts
case 'setOrnament': {
  next = withEvent(score, op.target, (e) => ({ ...e, ornament: op.ornament }))
  break
}
```

For a **new field**, add a new member to the `Operation` discriminated
union (`editOperations.ts:Operation`, ~L98) and a matching `case` in
`transformScore()` (~L940). `transformScore` is the **pure** transform
(no validation); `applyOperation` is `transformScore` + `validateScore`.
Out-of-range targets must `throw new EditError(...)` with a descriptive
message — the retry pipeline (`src/lib/orchestrator/handlers/scoreRetry.ts`)
feeds that message verbatim back to the LLM so it can re-target. **A
silent no-op is worse than a throw** — see the `withPitch` out-of-range
guard at `editOperations.ts` (~L909) for the rationale.

### 5b — Editor popover (`src/components/editor/OrnamentMenuPopover.tsx`)

Add a cell to the relevant group. The ornament cells live in
`ORNAMENT_GROUPS` at `OrnamentMenuPopover.tsx:46`:

```ts
{
  label: 'Turn',
  options: [
    { value: 'turn', label: '∽', title: 'Turn' },
    { value: 'haydn-ornament', label: '∽+', title: 'Haydn ornament' }, // ← new
    // ...
  ],
},
```

The popover is intentionally **decoupled from the chat store**: it emits
an `OrnamentMenuPatch` via `onPatch`, and the *call site* maps the patch
to an op. That call site is `src/components/editor/NoteFloatingMenu.tsx`
(~L1637), which translates `{ kind: 'ornament', ornament }` into
`applyEdit({ kind: 'setOrnament', target: selection, ornament })`. The
popover is opened from three places, all in `NoteFloatingMenu.tsx`: the
trigger button (which now lives inside the **Expression** category
`SubMenu` — its `onClick` calls `openFromSubmenu` to close the submenu
before opening the popover so it anchors at the selection), the `Shift+O`
shortcut (`useShiftLetterPopover`), and the palette dispatch (`case
'open-ornament'`). (Line numbers shift as the file evolves — search by
symbol. Secondary-action buttons are grouped into category `SubMenu`s; see
[`../subsystems/editor-ui.md`](../subsystems/editor-ui.md).)

> **Gotcha — closure-staleness.** Cross-field cleanup (e.g.
> auto-clearing an orphan `trillUpperPitch` when the ornament leaves the
> trill family) is dispatched at the `NoteFloatingMenu.tsx` call site,
> **not** inside the popover, so it can re-read the live event from the
> store (`useChatStore.getState().editedScore`). The popover's `current`
> prop is closure-stale across a rapid double-click. See the comment at
> `NoteFloatingMenu.tsx:1648`.

### 5c — Command catalog (`src/components/editor/commandCatalog.ts`)

If your feature needs its **own** Cmd-K entry, add a `COMMAND_CATALOG`
item. For a new *value* on an existing field you usually reuse the
existing entry — the ornament popover already has `open-ornament`
(`commandCatalog.ts:210`) which publishes a `PaletteRequest` via
`s.setPaletteRequest({ kind: 'open-ornament' })`. The popover-owning
component (`NoteFloatingMenu.tsx`) subscribes to that request and opens.
See [`../subsystems/command-palette.md`](../subsystems/command-palette.md)
for the nonce-stamped dispatch bus.

### 5d — Action summary (`src/lib/orchestrator/summarizeAction.ts`)

Every op gets a human-readable label for the chat transcript and ghost
preview. The `setOrnament` case is at `summarizeAction.ts:288`:

```ts
case 'setOrnament':
  return op.ornament === 'none' ? 'Cleared an ornament' : `Set an ornament (${op.ornament})`
```

A new enum value rides the existing template for free. A **new op**
needs a new `case` here, or the summary falls through to a generic
label.

## Step 6 — Expose it to the LLM (the render_score tool schema)

The LLM authors Scores via a **hand-written JSON Schema** that mirrors
the Zod schema — it is *not* generated from Zod. It lives in
`src/lib/llm/renderScoreTool.ts`. (Despite the `render_score` /
`renderScoreTool` naming, this is the tool the orchestrator's tool-use
dispatch hands the model; grep `renderScoreTool` to find it.)

Two edits:

1. Add the value to the mirror enum `ORNAMENT_ENUM`
   (`renderScoreTool.ts:29`):

```ts
const ORNAMENT_ENUM = [
  'trill',
  // ...
  'haydn-ornament',   // ← keep in sync with OrnamentSchema
  'none',
] as const
```

2. Update the `ornament` property `description`
   (`renderScoreTool.ts:347`) so the model knows when to pick it. The
   description is load-bearing — it is the model's only documentation
   for the value, and it is where deferred-render caveats are stated
   ("Schema accepts and persists today; visual rendering lands in a
   follow-up PR").

> **Invariant:** `ORNAMENT_ENUM` is a *manual copy* of
> `OrnamentSchema.options`. The file header and the sync-pin test (step
> 9) require they match exactly. The same bound-agreement rule applies
> to array caps — e.g. `annotations.max(100)` in `ScoreSchema` matches
> the `maxItems` hint in the tool, noted at
> `src/lib/music/types.ts` (~L1201).

## Step 7 — MusicXML export mapping

`src/lib/music/export/musicxml.ts:scoreToMusicXml` (L198) builds
MusicXML 4.0 directly from the Score model (not from ABC). Map your
value to the correct MusicXML element and **respect ordering** — the
`<notations>` children must appear in the spec order
(tied → slur → tuplet → glissando → ornaments → technical →
articulations → fermata), documented at `musicxml.ts` (~L1149).

> **Real gotcha worth knowing before you wire it:** at SHA `150cb15`,
> per-event `Event.ornament` values are **not** emitted to MusicXML.
> The only ornament that exports is the **trill-LINE span** (a `Span`
> of kind `trill-line`), which emits `<ornaments><trill-mark/>` on its
> start event (`musicxml.ts:1244`). So adding `haydn-ornament` to
> `Event.ornament` will round-trip through ABC + the editor but will
> silently drop on MusicXML export until the per-event ornament emit is
> built. If your feature is a per-event ornament, decide whether to
> (a) add the missing per-event ornament emit path, or (b) document the
> export gap in the tool description (step 6) and a test (step 8). Do
> not assume an export path exists — grep `musicxml.ts` for your field
> name and confirm.

See [`../subsystems/export.md`](../subsystems/export.md).

## Step 8 — Tests (unit + factory)

There is **no shared `tests/factories/Score` builder** — each test file
defines a small inline `makeEvent` / `makeScore` helper (e.g.
`tests/unit/music/ornaments.test.ts` defines its own `makeEvent`). The
`tests/factories/` dir holds DB/env factories only (`db.ts`,
`testEnv.ts`), not Score factories. Follow the local-helper convention:

```ts
// tests/unit/music/ornaments.test.ts (pattern)
const makeEvent = (extra: Partial<Event> = {}): Event => ({
  pitches: [{ step: 'C', octave: 4 }],
  duration: 'quarter',
  ...extra,
})
```

Write at minimum:

- **Schema test** — `OrnamentSchema.parse('haydn-ornament')` succeeds;
  an invalid value throws.
- **Emission test** — a Score with the value produces the expected ABC
  token (`tests/unit/music/scoreToAbc.test.ts` /
  `scoreToAbcWithMap.test.ts` style).
- **Edit-op test** — `transformScore(score, { kind: 'setOrnament', … })`
  sets the field (`tests/unit/music/editOperations.perNoteMarkings.test.ts`
  style).
- **Sync-pin test** — see step 9.

## Step 9 — The sync-pin pattern (the part that saves you)

Because enum values are duplicated across hand-written surfaces, the
codebase pins them together with tests that assert the copies equal the
**source-of-truth Zod schema**. If you add a value to `OrnamentSchema`
but forget `ORNAMENT_ENUM`, the pin test fails with a clear diff
instead of the value silently never reaching the LLM.

The canonical example is `GRACE_DURATION_ENUM`, pinned at
`tests/unit/llm/renderScoreTool.test.ts:172`:

```ts
it('GRACE_DURATION_ENUM is in sync with GraceDurationSchema (source of truth)', async () => {
  const { GraceDurationSchema } = await import('@/lib/music/types')
  const sourceOfTruth = GraceDurationSchema.options
  // ...extract the wire enum from the tool schema...
  expect(wireEnum).toEqual([...sourceOfTruth])
})
```

Other sync-pinned surfaces in the same file: `marker.metricModulation`
(L526), `marker.key` (L547), chord `quality/seventh/modal` enums
(L478). **When you add `ORNAMENT_ENUM` in step 6, add the matching
sync-pin** that asserts `wireEnum.toEqual([...OrnamentSchema.options])`.

The sibling pattern on the **Score-model side** is the exported `*_KINDS`
const. `src/lib/music/types.ts` exports
`BARLINE_KINDS = BarlineSchema.options` (L661) explicitly so that the
`render_score` schema, the `editIntraMeasure` op-bag schema, and the
editor UI selectors all *import the same const* — adding a 9th barline
kind to `BarlineSchema` is caught by sync-pin tests
(`tests/unit/orchestrator/editIntraMeasure.barlineSchema.test.ts`,
`tests/unit/llm/renderScoreTool.barlines.test.ts`) instead of silently
skipping the new kind on some surface. The span families follow the same
discipline in `src/lib/music/spans.ts`:
`HAIRPIN_KINDS` (L32), `SLUR_KINDS` (L48), `TEMPO_SPAN_KINDS` (L69),
`OCTAVE_SPAN_KINDS` (L93), `JUMP_KINDS` (L381) — each a single exported
const consumed by the schema, the op layer, and the UI.

> **Rule of thumb:** if a value's vocabulary is repeated in more than
> one file, promote it to one exported `as const` array and have the
> others import it — or, when a manual mirror is unavoidable (the
> hand-written JSON Schema in `renderScoreTool.ts`), add a sync-pin
> test. Never leave two hand-edited copies with no test between them.

---

## Final checklist

```
[ ] 1. OrnamentSchema enum + (new field only) export type        types.ts
[ ] 2. Helper updated if legacy/structured split applies          ornaments.ts / articulations.ts / …
[ ] 3. ornamentToAbc case (lossy-map comment if no abcjs glyph)   scoreToAbcWithMap.ts
[ ] 4. (nothing — abcjs renders legal tokens automatically)       synth.ts
[ ] 5a. setOrnament op + transformScore case (new field only)     editOperations.ts
[ ] 5b. popover cell + NoteFloatingMenu dispatch                  OrnamentMenuPopover.tsx / NoteFloatingMenu.tsx
[ ] 5c. palette entry (new command only)                          commandCatalog.ts
[ ] 5d. summarizeAction label (new op only)                       summarizeAction.ts
[ ] 6. ORNAMENT_ENUM + property description                       renderScoreTool.ts
[ ] 7. MusicXML mapping (CONFIRM an emit path exists!)            export/musicxml.ts
[ ] 8. schema + emission + edit-op unit tests                     tests/unit/music/…
[ ] 9. sync-pin test asserting wire enum == Schema.options        tests/unit/llm/renderScoreTool.test.ts
```

## See also

- [`../subsystems/music-model.md`](../subsystems/music-model.md) — the Score tree, validation, accessors
- [`../subsystems/edit-operations.md`](../subsystems/edit-operations.md) — the `Operation` union and `transformScore`
- [`../subsystems/abc-rendering.md`](../subsystems/abc-rendering.md) — Score→ABC+SourceMap and click round-trip
- [`../subsystems/command-palette.md`](../subsystems/command-palette.md) — the Cmd-K dispatch bus
- [`../subsystems/editor-ui.md`](../subsystems/editor-ui.md) — popover anchoring and selection model
- [`../subsystems/export.md`](../subsystems/export.md) — MusicXML / MIDI / PDF export
- `src/lib/orchestrator/README.md` — the orchestrator that hands the LLM the `render_score` tool
- Real files: `src/lib/music/types.ts`, `src/lib/music/ornaments.ts`,
  `src/lib/music/scoreToAbcWithMap.ts`, `src/lib/music/editOperations.ts`,
  `src/lib/llm/renderScoreTool.ts`, `src/lib/music/export/musicxml.ts`,
  `src/components/editor/OrnamentMenuPopover.tsx`,
  `src/components/editor/NoteFloatingMenu.tsx`,
  `src/components/editor/commandCatalog.ts`,
  `src/lib/orchestrator/summarizeAction.ts`, `src/lib/music/spans.ts`,
  `tests/unit/llm/renderScoreTool.test.ts`,
  `tests/unit/music/ornaments.test.ts`
