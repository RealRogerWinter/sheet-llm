---
title: Command Palette (Cmd-K)
subsystem: command-palette
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/components/editor/commandCatalog.ts
  - src/components/editor/CommandPalette.tsx
  - src/components/editor/CommandPalette.module.css
  - src/components/editor/useCommandPalette.ts
  - src/lib/chat/state.ts
  - src/components/editor/NoteFloatingMenu.tsx
  - src/components/editor/EditorToolbar.tsx
  - src/components/Hero.tsx
  - src/components/editor/Popover.tsx
related:
  - chat-store-state
  - note-floating-menu
  - editor-toolbar
  - popover-shell
  - ghost-preview-proposal
---

The Cmd-K / Ctrl-K command palette is a modeless, fuzzy-searchable,
category-grouped list of editor commands. Each command is a *pure
declaration* — a `PaletteCommand` whose `action` receives a fresh
chat-store snapshot at dispatch time. An action either mutates the
store directly (toggles, duration/accidental pickers) or publishes a
nonce-stamped `PaletteRequest` onto a **single-slot dispatch bus**
(`store.paletteRequest`). Popover-owning components
(`NoteFloatingMenu`, `EditorToolbar`) subscribe to that one slot, gate
on live state, open their popover, and clear the slot. The palette
itself owns no popover anchors; it only declares intent.

## Entry points

| Concern | File / symbol |
| --- | --- |
| Command authoring | `src/components/editor/commandCatalog.ts:COMMAND_CATALOG` |
| Palette UI | `src/components/editor/CommandPalette.tsx` (default export) |
| Global keybind | `src/components/editor/useCommandPalette.ts:useCommandPalette` |
| Mount + open boolean | `src/components/Hero.tsx` (line 60 hook, line 99 mount) |
| Dispatch bus slot | `src/lib/chat/state.ts` — `paletteRequest` / `setPaletteRequest` |
| Primary subscriber | `src/components/editor/NoteFloatingMenu.tsx` (effect ~256-335) |
| Secondary subscriber | `src/components/editor/EditorToolbar.tsx` (effect ~113-126) |

## Key files

| Path | Role |
| --- | --- |
| `src/components/editor/commandCatalog.ts` | `PaletteCommand` interface, the `COMMAND_CATALOG` (36 commands), and all pure helpers: `applyAvailabilityFilter`, `filterCommands` (reference substring filter, **not** used by the UI), `fuzzyFilterCommands` (the ranked filter the UI uses), `groupCommandsByCategory` + `CommandGroup`. Internal: `fuzzyTermScore`, `subsequenceScore`, `extractCategory`, and the predicate helpers `selectionHasEventWithId` / `selectionHasPitchedEvent`. |
| `src/components/editor/CommandPalette.tsx` | Default-exported component. Renders a centered `Popover` with a search input, fuzzy-filtered + category-grouped list, arrow/Enter keyboard nav, hover sync. Props `{ open; onClose; commands? }`. Snapshots the availability-filtered catalog once per open; resolves each `action` against a fresh `useChatStore.getState()` at dispatch. |
| `src/components/editor/CommandPalette.module.css` | Styles for `palette / input / list / empty / group / groupHeader / row / rowActive / label / keybind`. `.list` caps at `max-height: 320px` and scrolls. |
| `src/components/editor/useCommandPalette.ts` | `useCommandPalette(onOpen)` hook. Capture-phase `document` keydown listener for Ctrl/Cmd+K. `onOpen` held in a ref so the listener never re-attaches. |
| `src/lib/chat/state.ts` | Declares the `PaletteRequest` discriminated union (21 `kind` variants, each `{ kind; nonce }`), the bus slot `paletteRequest`, and `setPaletteRequest` (auto-bumps the nonce on every publish). |
| `src/components/editor/NoteFloatingMenu.tsx` | Bus subscriber for 20 selection-anchored kinds. Reads `paletteRequest`, early-returns if no `selection`, switch-dispatches to local `setXxxOpen()` / `setXxxTarget()`, then clears the slot. `open-score-info` falls through `default` and is left in the slot. |
| `src/components/editor/EditorToolbar.tsx` | Bus subscriber for **only** `open-score-info`. Anchors to the score-info trigger rect, opens the ScoreInfo popover, clears the slot. |
| `src/components/Hero.tsx` | Wiring site. Local React state `paletteOpen`; `useCommandPalette(() => setPaletteOpen(true))`; `<CommandPalette open={paletteOpen} onClose={...} />`. The open boolean is component state, **not** in the chat-store. |
| `src/components/editor/Popover.tsx` | Shared popover shell. Takes `anchorX / anchorY / estimatedWidth / estimatedHeight / ariaLabel`, clamps to the viewport, and owns the Esc-to-close handler the palette relies on. |

## Core concepts / data flow

### `PaletteCommand` shape

```ts
interface PaletteCommand {
  id: string
  label: string
  keybind?: string   // right-aligned display hint only — NOT a live binding
  hint?: string      // filterable secondary text AND the category source
                     //   format "Category / Sub" (e.g. "Span / Dynamics")
  action: (store: StoreSnapshot) => void
  available?: (store: StoreSnapshot) => boolean
}
// StoreSnapshot = ReturnType<typeof useChatStore.getState>
```

`keybind` is purely cosmetic — the real shortcuts live in the
respective `useShiftLetter…` hooks. `hint` does double duty: it is
matched by the fuzzy filter *and* its pre-`/` prefix is the group
header. A command with no `hint` lands in the `Other` group.

### End-to-end dispatch

```
  Cmd/Ctrl+K (capture-phase, any focus target)
        │  useCommandPalette → onOpen ref
        ▼
  Hero: setPaletteOpen(true)
        │
        ▼
  CommandPalette (closed→open effect):
    availableCommands = applyAvailabilityFilter(COMMAND_CATALOG, getState())
        │  user types → fuzzyFilterCommands → groupCommandsByCategory
        │  Enter / click → dispatch(cmd)
        ▼
  dispatch:  onClose()  THEN  cmd.action(useChatStore.getState())
        │
        ├── direct mutator ──► store (toggleCheatSheet / setActiveDuration / …)
        │
        └── bus publish ────► s.setPaletteRequest({ kind })  (nonce++)
                                    │
            ┌───────────────────────┴───────────────────────┐
            ▼                                                ▼
  NoteFloatingMenu effect                          EditorToolbar effect
   (20 selection kinds)                             (open-score-info only)
   gate on selection → setXxxOpen()                 anchor to trigger rect
   clear slot                                       → setScoreInfoOpen
   open-score-info → default → leave slot           clear slot
```

`dispatch` deliberately calls `onClose()` **before** `cmd.action(...)`
so a UI-mutating action lands on a fresh frame without the palette
overlapping — the same close-then-act ordering used across the popover
layer.

### Single-slot nonce bus

`paletteRequest` is **one** store slot, not N popover-specific slots.
`setPaletteRequest` takes `Omit<PaletteRequest, 'nonce'>` and
auto-increments the nonce on every publish (store owns the counter;
callers never pass a nonce). Subscriber effects depend on the whole
request object, so even a back-to-back identical kind (e.g. "Open
score info" twice) re-fires because the nonce changed. Calling
`setPaletteRequest(undefined)` clears the slot.

### Availability filter (per-open snapshot)

`applyAvailabilityFilter(commands, store)` runs each command's
`available(store)` predicate **once**, in the closed→open effect, and
stores the survivors in `availableCommands` state. Predicate tiers:

| Predicate | Commands |
| --- | --- |
| `undefined` (always shown) | View toggles, duration/accidental pickers, `open-score-info` |
| `(s) => s.selection !== undefined` | marker, dynamics, chord-symbol, lyrics, annotation, fingering, ornament, technique, grace-note, barline, volta, jump-marker |
| `(s) => s.measureRangeSelection !== undefined \|\| s.selection !== undefined` | `delete-measure` only (a Cmd/Ctrl+click measure range takes precedence; else the selected event's bar) |
| `selectionHasEventWithId` | span family: hairpin, slur, tempo-span, octave-span, glissando, trill-line, tremolo-between (span endpoints reference an event `id`) |
| `selectionHasPitchedEvent` | `open-tie` only (all three tie ops reject rests) |

This is intentionally **not** reactive to mid-session score edits: a
background edit must not invalidate the user's in-flight filter intent.
Re-snapshotting happens on the next open.

### Fuzzy search + ranking

`fuzzyFilterCommands(commands, query)` splits the query on whitespace;
**every** term must score `> 0` or the command drops (AND semantics).
Per-term tiers, highest first (`fuzzyTermScore`):

| Tier | Score |
| --- | --- |
| exact label | `10000` |
| label prefix | `5000 − label.length` |
| label substring | `1000 − idx − label.length` |
| label+hint substring | `500 − idx` |
| label subsequence | `100 + subsequenceScore` |
| label+hint subsequence | `50 + subsequenceScore` |
| no match | `0` → term rejected, command dropped |

`subsequenceScore` requires every needle char to appear in order
(non-contiguous allowed), returns `10 * contiguousRuns + max(0, 50 −
haystack.length)`. Results sort by total score desc, ties broken by
catalog index (stable sort → deterministic output). An empty /
whitespace-only query returns the catalog in authored order, unranked.

> `filterCommands` is a simpler reference substring AND-filter kept
> only for tests; the UI never calls it.

### Category grouping

`groupCommandsByCategory(commands)` derives each category via
`extractCategory(hint)` — the substring before the first `/`, trimmed;
a missing/empty hint yields `Other`. First-occurrence order is
preserved (no sort), so the section order matches the catalog's
authored order. The current catalog yields these categories in order:
**Score, Markers, Event, Span, Measure, View, Insert** (plus `Other`
if any hint is dropped). The UI renders a `groupHeader` per group, but
`activeIdx` tracks the **flat** filtered-list index (`filtered.indexOf(cmd)`)
so arrow keys advance through commands and skip headers naturally.

### Centered modeless popover

`CommandPalette` wraps the shared `Popover`, anchored at
`(innerWidth/2, floor(innerHeight/3))`; `Popover`'s clamp keeps the
frame on-screen, so no dedicated "centered" mode is needed.
`estimatedHeight = min(400, 80 + filtered.length * 30)` (80px chrome,
30px/row). Esc is **not** intercepted by the palette's `onKeyDown`; it
bubbles to `Popover`'s own handler to close.

## Invariants & gotchas

- **Actions must not close over the store.** Catalog declarations are
  pure; the action is invoked with `useChatStore.getState()` at
  dispatch time. Closing over a store reference at declaration would
  reintroduce stale-closure bugs.
- **`delete-measure` is the one catalog command that targets *measures*
  and does NOT publish a `PaletteRequest`.** Its `action` calls
  `store.requestMeasureDelete(range)` — `range` is the
  `measureRangeSelection` if set, else `{fromStart,fromEnd}` of the
  selected event's bar — which opens the always-confirm
  `MeasureDeleteConfirmModal` rather than dispatching a popover or
  editing directly. The span/marker-safe `dragMeasureRange` delete fires
  only on confirm. The same gate backs the `NoteFloatingMenu` Structure
  submenu's 🗑 button.
- **One owner per kind.** Each `PaletteRequest` kind is consumed by
  exactly one subscriber. The owner clears the slot
  (`setPaletteRequest(undefined)`); non-owners must early-return and
  leave the slot intact. `NoteFloatingMenu`'s `default` branch
  *returns without clearing* so `EditorToolbar` can still see
  `open-score-info`. Adding a kind without an owner = the slot never
  clears and the next publish of any kind still works (nonce bumps),
  but the orphaned request lingers.
- **Selection race guard.** A command's `available` predicate runs at
  open; the subscriber runs later. `NoteFloatingMenu` re-checks
  `selection` before acting (`if (!selection) return`) to cover
  publish-then-selection-cleared. Target snapshots
  (`setBarlineTarget` / `setVoltaTarget` / `setJumpMarkerTarget`) are
  set **before** the corresponding `setXxxOpen(true)`.
- **Span commands need an event `id`, not just a selection.** Span
  popovers render `null` without an endpoint id, which would
  soft-deadlock the open flag. Hence `selectionHasEventWithId` rather
  than the looser selection-only predicate.
- **Availability is snapshot-once, not reactive.** If you select an
  event *after* opening the palette, selection-gated commands stay
  hidden until you reopen. By design.
- **Cmd-K fires regardless of focus target** (capture phase,
  `stopPropagation`). It rejects `shift`/`alt` — bare `K` is reserved
  for the Shift+K voltas popover, so the modifier is required.
- **`paletteOpen` is local Hero state**, not store state. Tests that
  drive the open boolean must go through Hero, not the chat-store.
- **`keybind` is display-only.** Editing it changes the rendered hint,
  not the actual shortcut. Real bindings live in the `useShiftLetter…`
  hooks and `useCommandPalette`.

## How to extend / common tasks

**Add a command that calls an existing store mutator** (no popover):
append a `PaletteCommand` to `COMMAND_CATALOG` with an `action` that
calls the mutator, e.g. `action: (s) => s.toggleChordPalette()`. Give
it a `hint` of the form `"Category / Sub"` to place it in a group. Done
— no bus, no subscriber.

**Add a command that opens a popover:**
1. Add a `{ kind: 'open-foo'; nonce: number }` arm to the
   `PaletteRequest` union in `src/lib/chat/state.ts`.
2. Add the catalog entry with
   `action: (s) => s.setPaletteRequest({ kind: 'open-foo' })` and the
   appropriate `available` predicate (selection / event-id / pitched).
3. Add a `case 'open-foo':` to the owning subscriber's switch
   (`NoteFloatingMenu` for selection-anchored, `EditorToolbar` for
   toolbar-anchored). Set any target snapshot **before** the open
   flag. The shared tail `setPaletteRequest(undefined)` clears the
   slot; if you own it in `EditorToolbar`, clear it yourself in that
   effect.

**Change ranking:** edit `fuzzyTermScore` / `subsequenceScore` in
`commandCatalog.ts`. Keep the tie-break-by-index stable sort or the
grouped UI order will jitter.

**Change a category:** edit the command's `hint` prefix; grouping is
derived, no separate registry.

## Testing

| File | Covers |
| --- | --- |
| `tests/unit/components/editor/CommandPalette.test.tsx` | Palette UI: imports `applyAvailabilityFilter` + the filter/group helpers; renders the component, keyboard nav, dispatch. |
| `tests/unit/components/editor/useCommandPalette.test.tsx` | The Cmd/Ctrl+K capture-phase keybind (modifier gating, focus-agnostic firing). |
| `tests/unit/components/editor/paletteRequest.test.tsx` | The bus slot: nonce auto-bump, repeat-kind re-fire, subscriber consumption + clear. |
| `tests/unit/components/Hero.test.tsx` | Palette mount + `paletteOpen` open wiring. |

## Related files / See also

- `src/lib/chat/state.ts` — `PaletteRequest`, `paletteRequest`,
  `setPaletteRequest` (the bus).
- `src/components/editor/Popover.tsx` — the shell that owns
  Esc-to-close and viewport clamping.
- `src/components/editor/NoteFloatingMenu.tsx` /
  `src/components/editor/EditorToolbar.tsx` — the two bus subscribers.
- `src/lib/music/scoreAccessors.ts` →
  `getStaffEventAt` (used by `selectionHasEventWithId` /
  `selectionHasPitchedEvent`).
- `src/components/Hero.tsx` — mount + open boolean.
