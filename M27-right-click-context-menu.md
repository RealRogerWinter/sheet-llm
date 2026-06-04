---
title: "M27 — Right-Click Context Menu for the Notation Editor"
subsystem: editor-ui
audience: [engineers, product]
status: proposed
last_verified: 2026-06-03
verified_against: 0ebc7a5
source_paths:
  - src/components/ScorePanel.tsx
  - src/components/Hero.tsx
  - src/components/editor/eventAtX.ts
  - src/components/editor/clickInsertSlot.ts
  - src/components/editor/staffResolver.ts
  - src/components/editor/staffGeometry.ts
  - src/components/editor/useNoteClickHandler.ts
  - src/components/editor/useStaffInteractions.ts
  - src/components/editor/useMeasureRangeSelect.ts
  - src/components/editor/NoteFloatingMenu.tsx
  - src/components/editor/Popover.tsx
  - src/components/editor/SubMenu.tsx
  - src/components/editor/commandCatalog.ts
  - src/components/editor/keyboardShortcuts.ts
  - src/lib/chat/state.ts
related:
  - docs/subsystems/editor-ui.md
  - docs/ai-agents/context-cards/command-palette.md
  - docs/reference/env-flags.md
---

# M27 — Right-Click Context Menu for the Notation Editor

> **Milestone note.** `M26` is already shipped (`feat(orchestrator): M26 — bounded free-tier generation …`, #243). This feature is therefore scoped as **M27**, PRs `M27-PR-1` … `M27-PR-6`.

> **▶ Go-Big decision (2026-06-03):** the product owner chose to **go big** — add clipboard (cut/copy/paste) and AI entry points — and to **coexist** with the left-click floating toolbar. Sections 1–10 below specify the **M27 base menu** as originally written; the **Go-Big Revision** at the end of this doc adds **M28 (clipboard)** and **M29 (AI entry points)**.

## 1. Summary & motivation

We are adding a **right-click context menu** to the rendered abcjs score. Right-clicking a note, rest, chord-note, measure body, barline, or empty staff area will `preventDefault()` the browser menu and instead open a small, **context-sensitive** vertical menu anchored at the cursor, whose items act on *exactly what was right-clicked*. Today the editor already exposes ~20 editing verbs (accidentals, durations, articulations, dynamics, hairpins, slurs, barlines, voltas, measure-delete, …) but they are reachable only through the left-click `NoteFloatingMenu` toolbar (which floats *above* the note), the `⌘K` `CommandPalette`, or keyboard shortcuts — none of which a user discovers by right-clicking, the universal "what can I do here?" gesture in **Dorico, Finale, Sibelius, and MuseScore**. The menu is almost entirely a **reuse-and-route** exercise: it builds a `Selection` with the same hit-test resolvers every other gesture uses, calls `select(...)`, then dispatches the same `applyEdit` / `applyBalancedEdit` / `requestMeasureDelete` / `setPaletteRequest` paths the toolbar already calls. Worth it because it converts a hidden 20-action surface into a discoverable one for a near-zero new-logic cost, and it is the single most-expected interaction missing from a notation editor.

## 2. Goals / non-goals

**Goals**
- A `contextmenu` listener on the score container that classifies the target and opens a cursor-anchored, ARIA-correct vertical menu with items scoped to that target.
- Reuse — not reinvent — hit-testing (`resolveStaffFromY` → `eventAtX` / `clickInsertSlot` → `pitchFromY`), the `Selection` store model, and the existing dispatch paths (`applyEdit`, `applyBalancedEdit`, `requestMeasureDelete`, the `paletteRequest` bus).
- Per-context item sets driven by the existing `available()` predicates in `COMMAND_CATALOG`, so span/tie/rest gating is correct for free.
- Keyboard (`ContextMenu` key / `Shift+F10`) and touch (long-press) entry points that funnel into the **same** open routine.
- Dark-launched behind a client flag, default-off until the final PR.

**Non-goals**
- **No custom menu for non-score chrome.** Right-clicking the chat panel, transport bar, toolbar, page background, or any non-`scoreRef` element keeps the native browser menu. We do not globally suppress `contextmenu`.
- **No new editing capability *in the M27 base menu*.** Every M27 menu item maps to an *existing* operation, popover, or store action — no new `Operation`/popover/`PaletteRequest` kinds. (M28/M29 deliberately add a `pasteEvents` op and an `aiSeed` slot — see the Go-Big Revision.)
- **No drag-reorder** from the menu (out of scope entirely). Clipboard cut/copy/paste and AI entry points were originally deferred, but per the **Go-Big decision** are now in scope as follow-on milestones — clipboard = **M28**, AI entry points = **M29** (see the Go-Big Revision at the end of this doc). They stay out of the M27 base menu.
- **No barline-DOM tagging pass** in the MVP — barline targets resolve to their adjacent measure via `clickInsertSlot` (see §7). A dedicated barline tag is an Open Decision, not a goal.
- **No menu while a score is streaming or non-interactive** (`interactive === false` / `streamProgress` set).

## 3. UX design

### 3.1 Context → menu contents

Items are drawn from the real inventory: `NoteFloatingMenu` inline/SubMenu buttons (`applyEdit({kind:'setAccidental'|'setArticulations'|…})`, `applyBalancedEdit({kind:'changeDurationBalanced'|'removeBalanced'})`, `playFromSelection`, chord chips), `COMMAND_CATALOG` popover verbs (via `setPaletteRequest({kind:'open-*'})`), and `requestMeasureDelete`. **Primary action** = the bold default row, fired by `Enter` when the menu opens with that row pre-highlighted.

| Context | How it's classified | Menu contents (top → bottom) | Primary / default |
|---|---|---|---|
| **Single notehead** (pitched, `pitches.length === 1`) | `e.target.closest('.abcjs-note')` → `data-startchar` → `resolveClickPosition` | **Play from here** ▸; ♯ ♮ ♭ (`setAccidental`); **Duration ▸** (whole…16th + dotted via `changeDurationBalanced`); **Articulation ▸** (staccato/accent/tenuto/marcato/fermata/breath/caesura/bow); **Expression ▸** (Dynamics, Ornament, Technique → bus); **Text ▸** (Fingering, Grace, Annotation, Chord symbol, Lyrics → bus); **Lines ▸** (Tie; Hairpin/Slur/Octave/Gliss/Trill-line/Tremolo — *gated on `event.id`*); **Add to chord ▸** (+3/+5/+7); **Delete note** (`removeBalanced`) | **Delete note** |
| **Rest** | `closest('.abcjs-rest')` OR `event.pitches[0].step === 'rest'` | **Play from here**; **Duration ▸**; **Convert to note…** (opens `ChordPalette`); **Delete rest** (`removeBalanced`). *Suppress* rest-illegal items (bowing, fingering, grace, lyrics, tie, ornament, technique — they throw `EditError`). | **Delete rest** |
| **Chord-note** (`pitches.length > 1`, resolved `pitchIdx`) | `eventAtX` hit + `pitchFromY`+`nearestPitchIdx` refine (replicate `useNoteClickHandler.ts:82-103`) | **Focus this note** (`select({...,pitchIdx})`); **Remove this note from chord** (`applyEdit({kind:'removePitchFromChord',pitchIdx})`); then the whole-chord items (accidental/duration/articulation apply to the event); **Delete chord** (`removeBalanced`) | **Remove this note from chord** |
| **Whole measure** (clicked empty part of bar) | no `eventAtX` hit → `clickInsertSlot` → global `measureIdx` | **Insert note here** (`smartInsertNote` at `insertAfterIdx` + `applyScore`); **Barline ▸**, **Volta ▸**, **Jump/repeat ▸** (→ bus, snapshot `measureIdx`); **Select measure**; **Delete measure** (`requestMeasureDelete({fromStart:mi,fromEnd:mi})`) | **Select measure** |
| **Barline** | `closest('.abcjs-bar')`, infer `measureIdx` via `clickInsertSlot` at that X | **Set barline…** (`open-barline`, scoped to the *preceding* measure); **Add volta…**; **Delete measure** (preceding) | **Set barline…** |
| **Empty staff / blank score** | inside SVG, `eventAtX` miss AND `clickInsertSlot` miss/empty score | If score has measures: **Insert note here**, **Select measure**. If blank score: a minimal menu — **Generate with AI…** (focus chat) only, OR fall through to native menu (Open Decision D). | **Insert note here** (or none) |
| **Active multi-measure range** (right-click *inside* `[fromStart..fromEnd]`) | `clickInsertSlot.measureIdx` ∈ existing `measureRangeSelection` → keep range (mirror `resolveBarTarget` precedence, `keyboardShortcuts.ts:98-107`) | **Selected measures N–M** header; **Delete measures** (`requestMeasureDelete(range)`); **Set barline ▸** (applies per-bar). Right-click *outside* the range collapses to the single clicked bar. | **Delete measures** |
| **Grand-staff upper vs lower system** | `resolveStaffFromY` returns `staffIdx` + `systemEl`; `eventAtX`/`clickInsertSlot` scoped to `systemEl` and `staffFilter=staffIdx` | Identical item sets; the resolved `staffIdx` flows into the `Selection`/target so all ops hit the correct staff. **Upper-system click must never target the lower system** (the #257 bug class — `systemEl` scoping is mandatory). | (per target type above) |

### 3.2 Interaction details

- **Right-click selects, then opens.** The handler resolves the target, calls `select({...resolved, anchorX:e.clientX, anchorY:e.clientY})` (or `selectMeasureRange` for bar targets), then opens the menu at the cursor. This gives the user visible selection feedback (the same highlight the left-click path produces) *and* sets `anchorX/anchorY`, which any popover opened via the bus reuses to position itself.
- **Relationship to the left-click `NoteFloatingMenu`.** **They are mutually exclusive, and the context menu is a NEW component, not the re-anchored toolbar.** Rationale: `NoteFloatingMenu` is a horizontal `role="toolbar"` that hard-positions *56px above* the click (`top = anchorY - 56`, NoteFloatingMenu.tsx:465) and has **no anchor/open props** — it cannot be re-anchored at/below the cursor except by writing `anchorX/anchorY`, and even then it's the wrong shape/placement for a right-click menu. So: opening the context menu **suppresses** `NoteFloatingMenu` for that interaction (a new `contextMenu` store slot; `NoteFloatingMenu` returns `null` while it's set), and the context menu **reuses the toolbar's handlers/dispatch**, not its DOM. The left-click toolbar continues to appear on left-click; the context menu appears on right-click; never both at once.
- **Native-browser-menu escape hatch.** A **second right-click** while our menu is open (or `Shift`+right-click) passes through to the browser by *not* calling `preventDefault` (and closing our menu). Right-clicking anywhere off the score (chat, chrome, page) is never intercepted.
- **Dismissal.** Click-outside (document `mousedown` outside the menu root → close), `Esc` (with `stopPropagation` so the underlying selection isn't also cleared — mirror `Popover.tsx:61-71`), action-fire (close *before* dispatch, matching `CommandPalette.dispatch` ordering), and **scroll / zoom / wheel** (close on any `wheel`/`scroll`/`resize` because the anchor coordinates go stale under reflow zoom).

### 3.3 Input modalities (all funnel into one `openContextMenu(target, anchor)` routine)

- **Keyboard:** `ContextMenu` key and `Shift+F10` open the menu for the **current `selection`**, anchored at `selection.anchorX/anchorY` (already populated by the last click) — falling back to the score-center if absent. Mirrors `useCommandPalette.ts`'s capture-phase opener.
- **Touch:** **long-press** (~500ms, movement < threshold) synthesizes the same `openContextMenu` call at the touch point. Net-new (no existing long-press in the editor; only `useScoreWheelZoom` handles pinch) — **deferred to a dedicated PR** so the pointer-vs-scroll disambiguation is isolated.
- **Mouse:** `contextmenu` event (`e.button === 2`). See Open Decision A for the macOS `Ctrl+click` collision with measure-range-select.

## 4. Architecture & data flow

### 4.1 Where `onContextMenu` attaches + coordinates

A **new mount-once hook `useScoreContextMenu(scoreRef)`** attaches `container.addEventListener('contextmenu', onContextMenu)` on the inner `scoreRef` div in `ScorePanel.tsx` (the `role="application"` div at lines 175-181), alongside the existing 5 hooks (`ScorePanel.tsx:167-171`). It reads the store via `useChatStore.getState()` *inside the handler* (deps `[scoreRef]` only — never tears down on edits), matching `useStaffInteractions`/`useNoteDrag`.

**No coordinate translation.** Every hit-test helper takes raw `e.clientX/e.clientY` and internally calls `getBoundingClientRect()`, which is already viewport-relative and already reflects scroll *and* zoom-reflow (zoom physically resizes the SVG via `staffwidthForZoom`, not a CSS transform). **Do not** subtract `scoreRef.getBoundingClientRect()` or apply a zoom factor — that double-corrects. The one exception, `pitchFromY` (staffGeometry.ts:81-89), does its own `viewBox` transform internally and only needs the correctly-resolved `staffEl` passed in.

### 4.2 Hit-test → **context classifier** (new pure-ish function)

A new module `src/components/editor/contextTarget.ts` exposes a single classifier composing the existing resolvers. It is *DOM-reading* (needs the live `svg`) but otherwise pure given `editMap`/`editedScore`:

```ts
// src/components/editor/contextTarget.ts
export type ContextTarget =
  | { kind: 'note';     selection: Selection }                 // pitched single note
  | { kind: 'rest';     selection: Selection }                 // rest event
  | { kind: 'chordNote';selection: Selection /* pitchIdx set */ }
  | { kind: 'measure';  measureIdx: number; insertAfterIdx: number; staffIdx: number }
  | { kind: 'barline';  measureIdx: number; staffIdx: number } // measureIdx = preceding bar
  | { kind: 'range';    range: MeasureRangeSelection }          // click inside live range
  | { kind: 'empty';    measureIdx?: number; staffIdx?: number }// staff area / blank score
  | { kind: 'none' }                                            // off-score / pre-render → pass through

export function classifyContextTarget(
  svg: SVGSVGElement,
  e: { clientX: number; clientY: number; target: EventTarget | null },
  editMap: SourceMap,
  editedScore: Score,
  activeRange: MeasureRangeSelection | undefined,
): ContextTarget
```

Internal branch order (mirrors `useStaffInteractions` exactly):
1. `el = (e.target as Element).closest('.abcjs-note, .abcjs-rest, .abcjs-bar')`.
2. `resolved = resolveStaffFromY(svg, e.clientY, getStaffCount(editedScore))`; if `undefined` → `{kind:'none'}` (pre-render / non-interactive).
3. If `el` matches `.abcjs-note`/`.abcjs-rest`: read `data-startchar` → `resolveClickPosition` → `Selection`. Branch `note`/`rest` by `event.pitches[0].step === 'rest'`. If `pitches.length > 1`: refine `pitchIdx` via `pitchFromY(svg, e.clientY, clef, resolved.staffEl)` + `nearestPitchIdx` → `chordNote`.
4. Else if `el` matches `.abcjs-bar`: `clickInsertSlot(svg, e.clientX, editMap, resolved.staffIdx, resolved.systemEl)` → `barline` (`measureIdx` = preceding bar).
5. Else (`eventAtX` miss): `eventAtX(svg, e.clientX, editMap, resolved.systemEl, resolved.staffIdx)`. On hit, treat as note/rest (step 3 from the hit). On miss: `clickInsertSlot(...)`. If its `measureIdx ∈ activeRange` → `range`; else `measure`; if `clickInsertSlot` is `undefined`/empty score → `empty`.

This keeps **SourceMap as truth** — `measureIdx` always comes from `resolveClickPosition`/`clickInsertSlot`, never DOM order; `systemEl` scoping is mandatory (skip it and you reintroduce #257).

### 4.3 Selection integration

- `note`/`rest`/`chordNote` → `select({...selection, anchorX:e.clientX, anchorY:e.clientY})` (plain setter, `state.ts:1162`).
- `measure`/`barline`/`empty(measureIdx)` → `selectMeasureRange({fromStart:mi, fromEnd:mi})` **and** clear stale per-event selection via `select(undefined)` (mirror `useMeasureRangeSelect.ts:95`). The menu then reads `measureRangeSelection`.
- `range` → leave `measureRangeSelection` as-is (keep the user's multi-bar range), per `resolveBarTarget` precedence.
- The anchor for the *menu itself* is stored in a new slot (see §4.4) so positioning is independent of the selection setters.

### 4.4 Menu component decision

**Build a new `ContextMenu` component (rendered via the existing `Popover` shell) that reuses `NoteFloatingMenu`'s handlers + the `paletteRequest` bus — do NOT re-anchor `NoteFloatingMenu`.** Rationale: `NoteFloatingMenu` has no anchor/open props and is a horizontal toolbar pinned *above* the click; a vertical drop-at-cursor menu is a different widget, but its **dispatch logic is 100% reusable**. Concretely:

- **Container:** `<Popover open anchorX anchorY ariaLabel="Context menu" onClose=…>` for free viewport clamping, flip-above-on-clip, `Esc`+`stopPropagation`, and `onMouseDown` containment. **Caveat:** `Popover` centers on `anchorX` (`anchorX - estimatedWidth/2`, Popover.tsx:81). For left-edge-at-cursor, pass `anchorX + estimatedWidth/2` (cheapest), and add an **outside-click-to-close** listener (Popover does *not* provide one — copy `OverflowMenu.tsx:13-28`).
- **Items:** inline edits dispatch the **same op literals** the toolbar uses — `applyEdit({kind:'setAccidental',target:selection,accidental})`, `applyBalancedEdit({kind:'changeDurationBalanced',selection,duration})`, `applyEdit({kind:'setArticulations',…})`, `applyEdit({kind:'removePitchFromChord',pitchIdx})`, `playFromSelection(selection)`.
- **Popover-backed editors** (Dynamics, Hairpin, Slur, Barline, Volta, JumpMarker, Fingering, Grace, Annotation, Chord symbol, Lyrics, Ornament, Technique, Tempo/Octave/Gliss/Trill/Tremolo spans, Tie): **publish `setPaletteRequest({kind:'open-*'})`** after setting selection. The existing `NoteFloatingMenu` subscriber (`NoteFloatingMenu.tsx:250-329`) opens them anchored at `selection.anchorX/Y`, snapshotting measure targets for `open-barline`/`open-volta`/`open-jump-marker`. **Zero new popover wiring.** (Note: `NoteFloatingMenu` must remain mounted to host these popovers even while suppressed as a toolbar — gate only its *toolbar render*, not the subscriber. See §7.)
- **Item set + gating:** call `applyAvailabilityFilter(COMMAND_CATALOG, useChatStore.getState())` *after* `select(...)` so the `available()` predicates resolve against the right-click target — this gives span-`id` gating, rest gating (`open-tie` requires a pitched event), and selection gating for free.
- **Measure-delete:** `requestMeasureDelete(range)` → `MeasureDeleteConfirmModal`, never a raw delete op.

### 4.5 Positioning / dismiss

Reuse `Popover` for clamping/`Esc`/containment; add `OverflowMenu`'s outside-click + the `wheel`/`scroll`/`resize`-to-close listeners. ARIA `role="menu"`/`menuitem` + arrow-key roving is supplied by `ContextMenu`'s own children (Popover is `role="dialog"`), borrowing `CommandPalette`'s `ArrowUp/Down`+`Enter`+`Esc` keyboard model (swap `listbox/option` → `menu/menuitem`).

### 4.6 Reuse map

| Existing asset | How this feature uses it |
|---|---|
| `resolveStaffFromY` (`staffResolver.ts:133`) | First call in classifier → `{staffIdx, staffEl, systemEl}`; `systemEl` scopes all later scans to one system. |
| `eventAtX` (`eventAtX.ts:34`) | Is-the-cursor-on-a-note test → `{measureIdx,eventIdx}` (no `pitchIdx`). |
| `pitchFromY` + `nearestPitchIdx` (`staffGeometry.ts:71`, `useNoteClickHandler.ts:24`) | Chord-note `pitchIdx` refinement (clef-aware via `staffEl`). |
| `clickInsertSlot` (`clickInsertSlot.ts:57`) | Global `measureIdx` + `insertAfterIdx` for measure/barline/empty + "Insert note here". |
| `resolveClickPosition` (`scoreToAbcWithMap.ts:2543`) | `data-startchar` → full `Selection`. |
| `select` / `selectMeasureRange` / `extendMeasureRangeTo` (`state.ts:1162/1164/1187`) | Select the target before opening. |
| `applyEdit` / `applyBalancedEdit` (`state.ts:1240/1330`) | Inline note/chord/duration/delete dispatch. |
| `requestMeasureDelete` (`state.ts:1204`) | Confirm-gated measure delete. |
| `setPaletteRequest` + `NoteFloatingMenu` subscriber (`state.ts:885`, `NoteFloatingMenu.tsx:250`) | Open the ~21 editor popovers anchored at the cursor. |
| `COMMAND_CATALOG` + `applyAvailabilityFilter` + `groupCommandsByCategory` (`commandCatalog.ts`) | Source-of-truth item list, per-target filtering, category grouping. |
| `resolveBarTarget` precedence (`keyboardShortcuts.ts:98`) | Range-vs-collapse decision for bar targets. |
| `Popover` (`Popover.tsx`) | Menu container: clamp, flip, `Esc`, containment. |
| `OverflowMenu` dismiss (`OverflowMenu.tsx:13`) | Outside-click-to-close + `role="menu"` precedent. |
| `CommandPalette` keyboard nav (`CommandPalette.tsx:96`) | Arrow/Enter/Esc roving (re-roled menu/menuitem). |
| `useCommandPalette` (`useCommandPalette.ts`) | Capture-phase opener template for `ContextMenu`/`Shift+F10`. |
| `SubMenu` (`SubMenu.tsx`) | Cascading sub-flyouts (Duration ▸, Articulation ▸), trigger-rect-in-handler anchor pattern. |
| `Hero.tsx` (~line 93) | Mount point for `<ScoreContextMenu/>` overlay (sibling of `NoteFloatingMenu`). |

## 5. Incremental PR breakdown (M27)

Each PR is independently shippable; the feature is **dark behind `NEXT_PUBLIC_SL_CONTEXT_MENU` (default off)** until PR-6 flips it.

**M27-PR-1 — Classifier + flag scaffold (dark).**
*Scope:* Add `classifyContextTarget` (`contextTarget.ts`) + `ContextTarget` union; add the client flag reader; add a `contextMenu` store slot (`{target, anchorX, anchorY} | undefined`) with `openContextMenu`/`closeContextMenu` actions. No UI.
*Acceptance:* unit tests for every `ContextTarget` variant (note/rest/chordNote/measure/barline/range/empty/none) over a synthetic SourceMap + stubbed `getBoundingClientRect`; classifier returns `none` when `resolveStaffFromY` is `undefined`; `measureIdx` always sourced from SourceMap, never DOM index; flag reader returns `false` by default.
*Flag:* off (no consumer yet).

**M27-PR-2 — `ContextMenu` component + `useScoreContextMenu` hook (note/rest/chord) (dark).**
*Scope:* New `ContextMenu` (vertical, `Popover`-hosted, `role="menu"`) + `useScoreContextMenu(scoreRef)` mounted in `ScorePanel`; wire note/rest/chordNote contexts to `select(...)` + inline `applyEdit`/`applyBalancedEdit` + bus items. Suppress `NoteFloatingMenu` toolbar render while `contextMenu` is set (keep its subscriber mounted). Gated by the flag (no-op when off / `interactive===false`).
*Acceptance:* with flag on, `contextmenu` on a notehead `preventDefault`s, selects it, opens a menu at the cursor; "Delete note" fires `removeBalanced`; rest menu hides bowing/tie/lyrics; chord-note menu offers "Remove this note from chord"; flag off → native menu, no listener effect.

**M27-PR-3 — Measure / barline / empty-staff + range (dark).**
*Scope:* Wire `measure`/`barline`/`range`/`empty` contexts: `selectMeasureRange`, "Insert note here" (`smartInsertNote`), `Set barline…`/`Volta…`/`Jump…` via bus, "Delete measure(s)" via `requestMeasureDelete`. Implement the range-vs-collapse rule.
*Acceptance:* right-click empty bar selects that measure + offers Insert/Delete; right-click inside a live multi-bar range keeps the range and "Delete measures" deletes all; right-click a barline opens `open-barline` scoped to the preceding measure; "Delete measure" routes through the confirm modal; "Delete all measures" item disabled when range covers the whole score.

**M27-PR-4 — `available()` gating + category SubMenus + dismiss polish (dark).**
*Scope:* Drive the item list through `applyAvailabilityFilter`/`groupCommandsByCategory`; render category cascades via `SubMenu`; add outside-click + `wheel`/`scroll`/`resize`-to-close; mutual exclusion polish with `NoteFloatingMenu`.
*Acceptance:* span items absent on un-`id`'d events; `open-tie` absent on rests; menu closes on outside-click, `Esc`, scroll, zoom; opening the context menu closes any open floating-menu popover and vice-versa; no double menus.

**M27-PR-5 — Keyboard + touch + ARIA/focus (dark).**
*Scope:* `ContextMenu` key + `Shift+F10` open for current `selection` (capture-phase, `useCommandPalette` pattern); touch long-press; full ARIA (`role="menu"/menuitem`, `aria-haspopup`, focus trap + restore, arrow roving, `prefers-reduced-motion`).
*Acceptance:* keyboard opens/navigates/fires/closes with no mouse; focus returns to `scoreRef` on close; long-press opens at touch point without triggering insert/drag; reduced-motion disables the fade; axe/RTL a11y assertions pass.

**M27-PR-6 — Flip default ON + docs re-stamp (M27 complete).**
*Scope:* Change the flag reader to default-on (kill-switch semantics); re-stamp `docs/subsystems/editor-ui.md` + its context-card; update `docs/reference/env-flags.md`; run `pnpm docs:check`.
*Acceptance:* default build shows the context menu; `NEXT_PUBLIC_SL_CONTEXT_MENU=off` fully disables it; `pnpm docs:check` clean; `pnpm lint && pnpm typecheck && pnpm test` green; commit subject `feat(editor): … (M27-PR-6, M27 complete)`.

## 6. Accessibility & input

- **ARIA:** menu panel `role="menu"` + `aria-label="Score context menu"`; rows `role="menuitem"` (or `menuitemcheckbox` for toggles like staccato); cascades use `aria-haspopup="menu"` + `aria-expanded` (copy `SubMenu`); the virtual trigger announces `aria-haspopup`. (`OverflowMenu` is the repo's only `role="menu"` — match it but add roving it lacks.)
- **Keyboard nav:** `ArrowDown/Up` move the active item (clamped, wrap optional), `ArrowRight`/`Enter` opens a cascade, `ArrowLeft`/`Esc` closes the cascade/menu, `Home/End` jump, type-ahead optional. Reuse `CommandPalette.tsx:96-110`, re-roled. `onMouseEnter` syncs `activeIdx` so pointer + keyboard agree.
- **Focus trap + restore:** on open, focus the menu (or the default item); trap `Tab` within; on close, **restore focus to `scoreRef`** (the `role="application"` div) so keyboard users return to the score.
- **`ContextMenu` key / `Shift+F10`:** capture-phase document listener (per `useCommandPalette`), `preventDefault`, opens at `selection.anchorX/anchorY`.
- **Touch long-press:** ~500ms timer cancelled on move/scroll; synthesizes `openContextMenu` at the touch point.
- **Reduced motion:** gate the `popoverFadeIn` animation behind `prefers-reduced-motion: no-preference` (the `Popover`/`NoteFloatingMenu` CSS fade is the thing to guard).

## 7. Edge cases & gotchas

- **Zoom-reflow coordinates:** pass raw `clientX/Y`; helpers use `getBoundingClientRect` (already zoom/scroll-correct because zoom is staffwidth-reflow, not transform). Never subtract container rect. `pitchFromY` does its own `viewBox` transform — pass the resolved `staffEl` or bass-clef chord clicks fall back to treble geometry.
- **Grand-staff system scoping:** `resolveStaffFromY` first, then pass `systemEl` to **both** `eventAtX` and `clickInsertSlot`, and `staffFilter=staffIdx` to `eventAtX` — skipping either reintroduces the #257 "upper click hits lower system" bug.
- **Active measure-range interplay:** mirror `resolveBarTarget` — inside-range keeps the range, outside collapses to one bar. Pick one target kind per right-click and clear the other selection slot (note-ops vs bar-ops must not be ambiguous).
- **Ghost-preview overlay interplay:** when `SL_GHOST_PREVIEW` has a pending proposal, the score is preview-state; the context menu should either be suppressed or its edits understood to **interrupt** the proposal (manual edits already interrupt per M24). Default: allow the menu (a manual edit interrupting a proposal is existing behavior), but verify it doesn't fight the resume toast. Flag as a test case.
- **Blank score / pre-render / `interactive===false`:** classifier returns `none`; the hook **does not `preventDefault`** → native menu shows. Same for streaming (`streamProgress` set) — never act on a score about to be clobbered by the next streamed section.
- **The "ScorePanel NUL byte":** the survey claim that `ScorePanel.tsx` has a NUL byte near line 5217 is **STALE/false** — confirmed 186 lines, reads cleanly. **However** the file IS UTF-16-encoded (Grep skips it as binary); read with the Read tool and **preserve encoding** on edit.
- **abcjs `selectables`/`data-startchar` dependency:** all hit-testing depends on `tagNoteheadsWithStartChar` (`ScorePanel.tsx:67-92`), which walks the undocumented `visualObj.engraver.selectables` (^6.6.x) and runs only when `interactive===true`. If an abcjs upgrade breaks it, the context menu silently degrades to no-op (single point of coupling). Barlines are **not** tagged (only `.abcjs-bar`) — hence the `clickInsertSlot` inference for barline targets.
- **Right-click during drag/playback:** if `useNoteDrag` is mid-drag, ignore `contextmenu`; during playback the menu may still open (Play-from-here is valid). Suppress only when read-only.
- **`NoteFloatingMenu` must stay mounted:** it **hosts the popover subscriber** (`:250-329`). Gate only its toolbar JSX (`return null` when `contextMenu` set), not the component — or the bus-opened popovers won't render.
- **Span soft-deadlock:** span popovers (`open-hairpin`/`slur`/`tempo-span`/`octave-span`/`glissando`/`trill-line`/`tremolo-between`) render `null` while `open===true` (and suppress `Esc`) for events without `event.id`. `applyAvailabilityFilter` (`selectionHasEventWithId`) must hide them — do **not** surface span items for un-`id`'d events.
- **macOS `Ctrl+click`:** synthesizes both a `contextmenu` event *and* collides with `useMeasureRangeSelect`'s `Ctrl/Cmd` gesture. Gate the listener on `e.button === 2` / not (`e.ctrlKey||e.metaKey`) to avoid double-firing (Open Decision A).
- **Multi-select:** if a per-event `selection` *and* a `measureRangeSelection` are both somehow set, the menu must pick scope from the *classified target*, not guess — the classifier's `range` vs `measure` vs `note` kind is authoritative.

## 8. Testing strategy

- **Unit (`tests/unit/components/editor/`):**
  - `contextTarget.test.ts` — classifier per target type over a synthetic `SourceMap` + stubbed element rects; asserts `kind`, `measureIdx` (SourceMap-sourced), `pitchIdx` refinement on chords, `systemEl` scoping (upper vs lower staff), `none` on pre-render.
  - `contextMenuItems.test.ts` — the item-set-per-context mapping (drives off `applyAvailabilityFilter` with a stubbed store): rest hides tie/bowing; un-`id`'d event hides spans; whole-score range disables "Delete all".
  - `ContextMenu.test.tsx` — render + ARIA roles + arrow/Enter/Esc nav + focus restore (mirrors `Popover.test.tsx`/`useCommandPalette.test.tsx`).
- **Integration (`tests/integration/`):** `contextmenu` event on a tagged notehead → `preventDefault` called → `select` fired with anchor → menu opens → "Delete note" → `applyBalancedEdit({kind:'removeBalanced'})` applied → score mutated; bus path: "Set dynamics…" → `setPaletteRequest({kind:'open-dynamics'})` → `NoteFloatingMenu` opens the popover.
- **e2e (`tests/e2e/`, optional in final PR):** real right-click → menu → action → audible/visible result; keyboard `Shift+F10` path.
- **Gates (per `CONTRIBUTING.md §2`):** deterministic trio `pnpm lint && pnpm typecheck && pnpm test` for every PR; `pnpm abcjs:spike` (touches abcjs DOM assumptions); **no `eval:smoke`** (pure-UI, no orchestrator/Score-model change). Note: `pnpm lint` is **already red on main** (pre-existing `react-hooks/refs` error in `useShiftLetterPopover.ts`) — do not add a new ref-in-render violation; capture all rects inside handlers (the `SubMenu`/`useCommandPalette` pattern).

## 9. Telemetry, flags & docs

- **Flag:** **`NEXT_PUBLIC_SL_CONTEXT_MENU`**, **default off**, flipped on in M27-PR-6. **Client-side `NEXT_PUBLIC_*`, not a server `SL_*` in `flags.ts`** — rationale: the gate is read purely in the browser (the `contextmenu` listener), and the repo's precedent for a browser-read kill-switch is `NEXT_PUBLIC_BALANCED_EDITS` (`state.ts:1339`) / `NEXT_PUBLIC_DEBUG_PANEL` (`debugStore.ts:101`). Reader uses `readBool`-style semantics while dark; PR-6 inverts to `!== 'off'` kill-switch semantics (matching `NEXT_PUBLIC_BALANCED_EDITS`). Document default + effect + rollback in `docs/reference/env-flags.md`.
- **Telemetry:** optional lightweight events `context_menu_opened` (`{targetKind}`) and `context_menu_action` (`{commandId}`) **if** an analytics sink already exists; otherwise omit (no new infra in scope).
- **Docs to update (maintenance protocol):**
  - `docs/subsystems/editor-ui.md` — add the context-menu flow + `useScoreContextMenu`/`ContextMenu`/`contextTarget.ts` to `source_paths`; add a "Add a right-click menu" bullet to its "How to extend" section; bump `last_verified`→today + `verified_against`→`git rev-parse --short HEAD`.
  - `docs/ai-agents/context-cards/editor-ui.md` — the 1:1 paired card; **same** frontmatter edit in the **same** PR.
  - `docs/reference/env-flags.md` — add `NEXT_PUBLIC_SL_CONTEXT_MENU` (default, effect, rollback); re-stamp.
  - `docs/ai-agents/context-cards/command-palette.md` — **only if** new `PaletteRequest` kinds are added (MVP reuses existing kinds → likely no touch).
  - Run `pnpm docs:check` (it exists on disk despite the "(specified)" label) before opening PR-6; re-stamp deep doc + card together or the checker re-flags the laggard.

## 10. Open decisions

**A. Right-click trigger gate: `e.button === 2` only, or also macOS `Ctrl+click`?**
*Options:* (a) fire only on true right-button / `contextmenu` with `!ctrlKey && !metaKey`; (b) also honor `Ctrl+click` on macOS.
*Recommended default:* **(a)** — `Ctrl/Cmd+click` is already owned by `useMeasureRangeSelect`; honoring it would double-fire the menu and the range gesture. macOS users still get the menu via two-finger/right-click and `Shift+F10`.

**B. Reuse `NoteFloatingMenu` verbatim (MVP) vs new vertical `ContextMenu`?**
*Options:* (a) just `select(...)` and let the existing toolbar appear; (b) new `Popover`-hosted vertical menu reusing the handlers.
*Recommended default:* **(b)** — the toolbar floats *above* the cursor, is horizontal, and has no anchor props; a right-click menu must drop *at* the cursor and be vertical. (b) reuses all dispatch for ~one new component's cost.

**C. Barline target identity: infer via `clickInsertSlot`, or add a barline-tagging pass?**
*Options:* (a) infer the preceding `measureIdx` from `clickInsertSlot` at the barline X (no new code); (b) extend `tagNoteheadsWithStartChar` to stamp `.abcjs-bar` with its measure.
*Recommended default:* **(a) for M27** — barline ops (`setEndBarline`, volta) are already measure-keyed, and inference is accurate enough; defer (b) to a follow-up only if users report mis-targeted barlines.

**D. Empty-area / blank-score right-click: minimal menu or pass-through to native?**
*Options:* (a) on a blank score, fall through to the native browser menu (`none`); (b) show a minimal "Generate with AI… / Insert note here" menu.
*Recommended default:* **(a) for blank score, (b) for non-empty empty-staff** — a blank score has no target, so the native menu is the honest behavior; an empty *bar* in a real score should offer Insert/Select/Delete.

---

## Appendix - referenced paths

**File paths referenced (all absolute):**
- Mount/host: `C:\Users\18084\sheet-llm\src\components\ScorePanel.tsx`, `C:\Users\18084\sheet-llm\src\components\Hero.tsx`
- New files proposed: `C:\Users\18084\sheet-llm\src\components\editor\contextTarget.ts`, `…\ContextMenu.tsx`, `…\useScoreContextMenu.ts`
- Reused: `…\editor\eventAtX.ts`, `clickInsertSlot.ts`, `staffResolver.ts`, `staffGeometry.ts`, `useNoteClickHandler.ts`, `useStaffInteractions.ts`, `useMeasureRangeSelect.ts`, `NoteFloatingMenu.tsx`, `Popover.tsx`, `SubMenu.tsx`, `commandCatalog.ts`, `keyboardShortcuts.ts`, `useCommandPalette.ts`, `CommandPalette.tsx`; `…\transport\OverflowMenu.tsx`; `C:\Users\18084\sheet-llm\src\lib\chat\state.ts`; `C:\Users\18084\sheet-llm\src\lib\music\scoreToAbcWithMap.ts`
- Flag precedent: `C:\Users\18084\sheet-llm\src\lib\chat\state.ts:1339` (`NEXT_PUBLIC_BALANCED_EDITS`), `…\src\lib\orchestrator\flags.ts` (server-flag pattern, NOT used here)
- Docs to stamp: `C:\Users\18084\sheet-llm\docs\subsystems\editor-ui.md`, `…\docs\ai-agents\context-cards\editor-ui.md`, `…\docs\reference\env-flags.md`

**Key correction vs the brief:** the next milestone is **M27**, not M26 — `M26` already shipped (free-tier bounded generation, #243).



---

# Go-Big Revision (2026-06-03) - Clipboard + AI entry points

> **Product decision:** the owner chose **GO BIG** (add clipboard cut/copy/paste + AI entry points) and **COEXIST** (keep the left-click floating toolbar; right-click is a new vertical menu). The M27 base menu (sections 1-10 above) is unchanged; clipboard and AI-entry are sequenced as **M28** and **M29** below.

## A. Clipboard model (cut / copy / paste)

**Payload representation — STRUCTURAL Score-fragment, not ABC-substring, not MusicXML.** Rationale: the in-app insert/duplicate primitives (`insertEventAfter`, `insertMeasuresAfter`, `regionReplace`, `dragMeasureRange` duplicate) all consume `Event[]`/`Measure[]` directly, so a structural fragment re-inserts with zero parse round-trip; an ABC slice (via `SourceMap` `startChar/endChar`) is lossy on cross-cutting layers (slurs/hairpins/ties/8va live in `score.spans` and emit as decorations *around* the event text, and per-pitch `tied_to_next`, `id`, `kind` are unrecoverable from the slice — the inverse ABC→Event path is the heavyweight import parser); MusicXML export is the heaviest and one-way.

**Clipboard entry shape** (new `src/lib/chat/clipboard.ts`), a discriminated union mirroring the two real selection scopes:

```ts
// the canonical in-memory fragment
export type ClipboardEntry =
  | {
      kind: 'events'                       // single note / chord / (future) intra-measure run
      events: Event[]                      // deep-cloned, ids RETAINED on the entry (refreshed at paste)
      sourceMeta: {
        meter: string                      // source measure meter (cut-time aware: 'C|')
        staffIdx: number; voiceIdx: number // source arity for paste-arity checks
        totalUnits: number                 // sum of DURATION_32NDS — drives balance math on paste
      }
    }
  | {
      kind: 'measures'                     // whole measure(s) / MeasureRangeSelection
      captured: ReturnType<typeof captureRangeContent> // {primaryMeasures, perVoiceContent}
      sourceMeta: {
        meter: string
        measureHashes: string[]            // hashMeasure() per bar — no-op-paste detection
        staffCount: number; voiceCount: number
      }
    }
```

**Storage — in-memory zustand slot is canonical truth; `navigator.clipboard` is a best-effort cross-app mirror.** A new `clipboard: ClipboardEntry | undefined` store slot (in `chat/state.ts`) holds full-fidelity structural data (ids, kind, the captured per-voice bundle) that cannot survive a text round-trip. On copy we *also* fire-and-forget `navigator.clipboard.writeText(JSON.stringify(serialized))` for cross-tab/app convenience; on paste we prefer the in-memory slot and only fall back to reading+`validateScore`-ing the system clipboard when the slot is empty (foreign paste). Rationale: the in-memory slot avoids permission prompts and preserves fidelity for the 99% intra-app case; the system-clipboard mirror is the "go big" cross-app affordance without making correctness depend on it. (Note: the existing `navigator.clipboard`/paste usages in the repo are the ABC/MusicXML *import* box only — there is NO reusable score clipboard infra.)

**COPY — per selection kind:**
- **Single event / chord** (`Selection`, `pitchIdx` undefined): `getVoiceMeasures(score, staffIdx, voiceIdx)[measureIdx].events[eventIdx]` → deep-clone into `kind:'events'` with `events:[clone]`. A chord is just an event with `pitches.length > 1` — copied whole.
- **Chord-note** (`pitchIdx` set): copy the *single pitch* as a one-pitch event (`kind:'events'`, `events:[{...event, pitches:[event.pitches[pitchIdx]]}]`) so "copy this note → paste elsewhere" yields one note, not the chord.
- **Intra-measure run** (NEW selection scope — see §E gotcha): slice `events[startEventIdx..endEventIdx]` into `kind:'events'`.
- **Whole measure(s) / range** (`MeasureRangeSelection {fromStart,fromEnd}`): `captureRangeContent(score, fromStart, fromEnd)` → `kind:'measures'`, tagged with `hashMeasure` per bar.

**PASTE — destination resolution + which op each path calls:**

| Clipboard kind | Right-click target | Destination resolution | Op / commit |
|---|---|---|---|
| `events` | note/rest/chord (event) | insert *after* `target.eventIdx` | **`pasteEvents` (new) committed via `applyScore`** — rebuilds the bar via `measureBalance`, then one history entry |
| `events` | empty bar slot | insert at `clickInsertSlot.insertAfterIdx` | same `pasteEvents` |
| `events`, exactly one event | empty bar, simplest path | — | reuse **`smartInsertNote`** with `defaults.pitches = entry.events[0].pitches` (its absorb→shrink→spill already balances) |
| `measures` | measure / empty bar | insert after `measureIdx` | **`applyEdit({kind:'insertMeasuresAfter', afterMeasureIdx: measureIdx, measures, perVoiceContent})`** (intra-doc same-score path can equivalently use `dragMeasureRange` duplicate) |
| `measures` | active multi-bar range | replace `[fromStart..fromEnd]` | **`applyEdit({kind:'regionReplace', startMeasureIdx, endMeasureIdx, measures, perVoiceContent})`** (M→N count change handled; severed spans dropped) |
| chord-note over a chord | "paste into chord" | add pitch to existing event | **`applyEdit({kind:'addPitchToChord' / 'removePitchFromChord'})`**-family — paste-special only |

On every paste, run `cloneCapturedRangeWithFreshIds(captured)` (measures) or `createEventId()` per event (events) so pasted ids are fresh and spans referencing the *originals* stay attached to the originals (matches `dragMeasureRange` duplicate semantics).

**Meter-balance handling (`measureBalance`) when pasted duration ≠ free space** — this is the net-new hard part; there is NO balanced-insert op today (`BalancedOp` is only `reorder/changeDuration/remove`). `pasteEvents(score, target, events)` composes the existing 32nd-exact primitives, structurally modeled on `smartInsertNote`:
1. `meterCapacityIn32nds(meter)` (cut-time-aware: `'C|'` → 16, not 32) and sum `DURATION_32NDS` of the run.
2. `consumeForRoom(events, 'back', runUnits)` to evict trailing rests for room; if it returns `shortfallUnits > 0` and refuses (`blocked:'tuplet'`), fall to spill.
3. If the run still overflows: `tieSplitOver(lastEvent, firstMeasureRoom, capacityUnits)` to cascade an over-long pasted note across ≤`MAX_CASCADE_DEPTH` (2) bars, else spill the remainder into a new bar fanned across all staves/voices (smartInsertNote's spill path).
4. `decompose32nds` + `fillWithRests` to pad leftover, `mergeAdjacentRests` to tidy.
5. Commit the rebuilt whole Score via **`applyScore(next, {selection, statusMessage})`** — ONE undo entry, dev-asserts `validateScore`. **Do NOT** paste via raw `insertEventAfter` (no balance, no validate, no id refresh → a bar that won't sum to capacity, tolerated by `applyEdit` but rejected on persistence).

**CUT = copy + balanced-delete as ONE coalesced undo step.** Copy is non-mutating (no history push), so CUT pushes exactly ONE history entry from its single mutating commit:
- **Cut note/chord:** write `ClipboardEntry` (no history) → **`applyBalancedEdit({kind:'removeBalanced', selection})`** (rest-pads the hole, guaranteed-valid, one entry).
- **Cut measure(s):** write `ClipboardEntry` (no history) → **`requestMeasureDelete(range)` → `confirmMeasureDelete` → `dragMeasureRange{mode:'delete'}`** (span/marker/volta-safe, confirm-gated, one `applyEdit` entry).
- **Cut intra-measure run:** write entry → one rebuilt-bar `applyScore`.

There is no multi-op transaction primitive in the store and the 500ms `coalesceKey` window only merges *repeated same-key* edits — so the discipline is "one mutating commit per cut," which the above already satisfies.

**New menu items per context + enable/disable predicates:**

| Item | Enabled when |
|---|---|
| **Cut** | target is event/chord/run/measure(s) AND not read-only/streaming |
| **Copy** | same as Cut |
| **Paste** | `clipboard !== undefined` AND kind-compatible: `kind:'events'` pastes onto event/empty-bar targets; `kind:'measures'` pastes onto measure/empty-bar/range targets. **Disabled** when clipboard empty OR kind incompatible (e.g. `measures` clipboard on a chord-note target). |
| **Paste special…** | submenu, enabled when paste enabled: "Paste into chord" (events→chord-note via `addPitchToChord`), "Paste over selection" (measures→range via `regionReplace`), "Replace measure(s)" (measures→measure via `regionReplace[mi..mi]`). |

---

## B. AI entry points

**Exact call path — there is ONE send action and it takes only a string.** `useSubmitPrompt().submit(rawMessage: string): Promise<{ok: boolean}>` (confirmed: it references neither `selection` nor `measureRangeSelection`; the wire `ChatRequest` carries only `chatId | message | editedScore | score_version | debug` — no region field anywhere in `ChatRequest`, `OrchestratorInput`, or `ToolDispatchInput`). The dispatcher LLM (`toolDispatch.ts`) parses bar numbers out of English and converts 1-based→0-based itself (prompt convention "bar 5 = index 4"). So a menu item's job is: read the right-clicked target's `measureIdx`/range (already produced by the M27 classifier), format a **1-based natural-language scoped prompt**, and call `submit(prompt)`. The Selection/MeasureRangeSelection is attached *by encoding the indices into the prompt text*, which is what routes the dispatcher to `region_replace` / `edit_intra_measure` / `insert_measures` server-side.

For v1 we use **prompt-text seeding (zero server change)**. The *optional* "go big" precision upgrade is to add `targetRegion?: {startMeasureIdx, endMeasureIdx}` to `ChatRequest` + `ChatRequestSchema` (route.ts) + `OrchestratorInput` + `ToolDispatchInput`, and have the dispatcher prefer it (pin `region_replace` args / the tool) when present — that is the ONLY net-new server wiring and it is deferred to the M29 final PR, not required to ship.

**Concrete menu items per context:**

| Context | Item | Prompt template (1-based) | Routes to | New wiring? |
|---|---|---|---|---|
| note / chord-note | **Edit this with AI…** | seeds chat input scoped to `In measure ${measureIdx+1}, …` | `edit_intra_measure` | none (seeded send) |
| measure | **Regenerate this measure** | `Rewrite measure ${measureIdx+1} entirely: …` | `region_replace[mi..mi]` | none |
| range | **Regenerate these measures** | `Rewrite measures ${fromStart+1}–${fromEnd+1}: …` | `region_replace[start..end]` | none |
| empty bar | **Generate here…** | `Add ${n} bars after measure ${measureIdx+1}: …` (or `Fill measure ${measureIdx+1} with …`) | `insert_measures` / `region_replace` | none |
| any | **Explain this with AI** | `Explain measure ${measureIdx+1}` | `answer_question` → converse stream | none |
| blank score | **Generate with AI…** | focus chat, empty scope | compose-from-scratch / score-stream | none |

Every item is "just a seeded/region-scoped send" — **no new orchestrator wiring** for v1. The only optional server change is the deterministic `targetRegion` field (M29 final PR).

**How results land — ghost-preview amber overlay + confirm (M24), free.** Because `SL_GHOST_PREVIEW` is default-ON, every score-mutating AI edit returns with `data.requiresConfirmation && data.proposal && data.scoreJson`, and `submit()` already routes that (useSubmitPrompt.ts:231) into `setPendingProposal` → `computeProposalPresentation` → amber inline overlay (≤4 affected events) or docked diff panel (≥5), accept(Enter)/reject(Esc) via `/api/chat/confirm-replacement`. The menu touches none of this — it inherits the M24 confirm UX.

**Interplay with the M3.5 replacement gate + preservation verifier:**
- The **replacement-as-confirmation gate** fires *before* the ghost-preview hook and is mutually exclusive (client checks `data.replacement` at line 190 *before* `data.proposal` at 231). For a scoped `region_replace`/`edit_intra_measure` on a few bars the gate almost never trips (retained bars stay byte-identical → high `retainedIdentityRatio`), so the edit lands as a normal ghost proposal. A "Regenerate this measure" on a *tiny* score COULD trip the gate → user gets the diff modal instead. That's acceptable confirm UX — so menu copy must NOT promise "amber preview" specifically.
- The **preservation verifier** re-hashes the bars a structural tool was told to retain (per-measure FNV1a over id-free events). "Edit bars 5–8 with AI" is protected server-side: bars 1–4 and 9+ are verified byte-stable; if the LLM corrupts a retained bar the handler throws and the orchestrator falls through. The menu enforces nothing here — it's trust-nothing server-side.
- **`answer_question`/"Explain"** returns an `OrchestratorConverseStream` *before* `finalizeDispatchResult`, so it skips preservation-verify, the replacement gate, AND ghost preview (no score mutation) — it streams text into an assistant bubble.

**Recommendation — "Edit with AI" SEEDS the docked chat input (focused, pre-filled, user types intent + sends); it does NOT fire a headless orchestrator call.** Rationale: `region_replace` *requires* a `hint` describing the new content, and the right-click alone carries the *target* but not the user's *intent*. A headless call would dead-end (the dispatcher's `edit_intra_measure` throws "model emitted no ops" on a vague prompt → clean 422 on free tier). Seeding the input with `In measure N, ` (caret at end) lets the user supply intent, then their send routes deterministically by index. The **exception** is **"Regenerate this measure"** and **"Generate here"** which carry enough intent on their own (regenerate = "rewrite this bar entirely") — those *may* fire `submit()` directly (headless) and land as a ghost proposal.

**Net-new store work for seeding:** there is no "seed the input box without sending" API today (PromptBar/PanelFooter own local input state). Add a small `aiSeed: {text, nonce} | undefined` store slot (mirroring the `paletteRequest` nonce-bus pattern) that the docked chat footer subscribes to and writes into its input + focuses. The existing 20 `PaletteRequest` kinds are popover-openers only — NONE route into chat — so this seed slot is genuinely net-new (one small slot, not a new orchestrator path).

---

## C. Revised milestone & PR plan

**Split: M27 = base discoverable menu (unchanged), M28 = clipboard, M29 = AI entry points.** Justification: clipboard requires a net-new balanced-paste op (`pasteEvents`) + a new selection scope (intra-measure run) + a clipboard store/transport layer; AI-entry requires a seed-input store slot + (optionally) a 4-file `targetRegion` wire extension + eval-pinned prompt templates. Each is its own coherent milestone-sized body of work, independently shippable, dark behind its own flag until that milestone's final PR. M28 and M29 are independent and can land in either order after M27; both *depend on* M27 (the classifier `ContextTarget` + `ContextMenu` host).

### M27 — Base discoverable menu (already specced; no change)
PR-1…PR-6 as written, dark behind **`NEXT_PUBLIC_SL_CONTEXT_MENU`** (default off → flipped on in PR-6).

### M28 — Clipboard (Cut / Copy / Paste), dark behind `NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD`

**M28-PR-1 — Clipboard store slot + `ClipboardEntry` type + copy serializer (dark).**
*Scope:* Add `clipboard` slot + `setClipboard`/`clearClipboard` to `chat/state.ts`; the `ClipboardEntry` discriminated union (`clipboard.ts`); the COPY serializers (single event / chord / chord-note pitch / measure-range via `captureRangeContent`) including `hashMeasure` tagging and the fire-and-forget `navigator.clipboard.writeText` JSON mirror. No menu items yet.
*Acceptance:* unit tests — copying a chord yields one `kind:'events'` entry with `pitches.length>1`; copying a chord-note yields a one-pitch event; copying a 2-bar range yields `kind:'measures'` with 2 `measureHashes`; deep-clone (mutating source does not mutate entry); JSON mirror parses back through `validateScore`. Flag reader defaults false.
*Flag:* off.

**M28-PR-2 — `pasteEvents` balanced-insert op + measures paste (dark).**
*Scope:* New `pasteEvents(score, target, events)` in `src/lib/music/pasteEvents.ts` composing `measureBalance` primitives (consume→tie-split→spill), returning a Score committed via `applyScore`; whole-measure paste via `insertMeasuresAfter`; range paste via `regionReplace`. All paste paths refresh ids (`createEventId` / `cloneCapturedRangeWithFreshIds`).
*Acceptance:* pasting a half-note run into a bar with one beat free spills the overflow into a new bar fanned across all staves (parity with `smartInsertNote`); pasting 2 measures via `insertMeasuresAfter` keeps total bar count = N+2 and every pasted event has a fresh id; pasting `measures` over a 3-bar range via `regionReplace` yields the pasted count; `validateScore` passes on every result; cut-time meter (`'C|'`) balances against 16 units not 32.
*Flag:* off.

**M28-PR-3 — Cut/Copy/Paste menu rows + enable/disable predicates (dark, gated under both flags).**
*Scope:* Add Cut/Copy/Paste/Paste-special rows to `ContextMenu` per §A table; Cut = copy + single mutating commit (`removeBalanced` for events, `requestMeasureDelete` for measures); Paste-special submenu (paste-into-chord / paste-over-range). Gated `NEXT_PUBLIC_SL_CONTEXT_MENU && NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD`.
*Acceptance:* Paste disabled when clipboard empty; Paste disabled when `kind:'measures'` clipboard on a chord-note target; Cut-note fires exactly ONE history entry (one undo restores it); Cut-measure routes through the confirm modal; copy→paste→undo round-trips to the pre-paste score in one Ctrl+Z.
*Flag:* off.

**M28-PR-4 — Intra-measure run selection + run copy/paste (dark).**
*Scope:* New multi-event selection scope `RunSelection {staffIdx?,voiceIdx?,measureIdx, startEventIdx, endEventIdx}` in `state.ts` (Shift-click range within a bar from the menu); wire run COPY (`kind:'events'` slice) and run PASTE through `pasteEvents`; strip/repair dangling trailing `tied_to_next` at run boundaries.
*Acceptance:* selecting events 2–4 of a bar and copying yields a 3-event entry; pasting it re-balances; a copied run whose last event was mid-tie has the dangling tie stripped (`validatePerPitchTies` clean). 
*Flag:* off.

**M28-PR-5 — Foreign-clipboard paste + span-carry decision + flip ON + docs (M28 complete).**
*Scope:* When the in-memory slot is empty, read `navigator.clipboard.readText` → parse → `validateScore` → paste (cross-app); copy+carry the spans whose BOTH endpoints lie inside the copied region (remap ids on paste) OR explicitly document them as dropped (decision: **carry-and-remap for `measures`, drop for single-event** to match `dragMeasureRange` duplicate); flip `NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD` to kill-switch default-on; re-stamp docs.
*Acceptance:* JSON pasted from another tab renders; a copied 2-bar slur survives paste with remapped ids; permission-denied on `readText` degrades gracefully to "nothing to paste"; `pnpm docs:check` clean; trio green.
*Flag:* default-on (`!== 'off'`).

### M29 — AI entry points, dark behind `NEXT_PUBLIC_SL_CONTEXT_AI`

**M29-PR-1 — `aiSeed` store slot + docked-chat seed subscriber (dark).**
*Scope:* Add `aiSeed: {text, nonce} | undefined` + `seedAiInput(text)` to `state.ts` (nonce-bus pattern, auto-bump like `setPaletteRequest`); the docked chat footer (`ChatHistoryPanel` PanelFooter) subscribes, writes `text` into its input and focuses. No menu items.
*Acceptance:* `seedAiInput('In measure 3, ')` fills + focuses the docked input without sending; back-to-back identical seeds re-fire (nonce bump); no send occurs.
*Flag:* off.

**M29-PR-2 — Edit-with-AI / Regenerate menu items (seeded + headless) (dark, gated under both flags).**
*Scope:* Add "Edit this with AI…" (note/measure → `seedAiInput` scoped prompt, focus chat), "Regenerate this measure(s)" (measure/range → headless `submit('Rewrite measure N entirely: …')`), "Generate here…" (empty bar → `seedAiInput('Add N bars after measure M: ')`). Prompts use **1-based** indices from the classifier target.
*Acceptance:* "Edit this with AI" on bar 5 seeds `In measure 5, ` (not `measure 4`) and focuses chat without sending; "Regenerate this measure" on bar 5 fires `submit` and the result lands as a ghost proposal (amber overlay or diff panel); a vague headless prompt that dead-ends surfaces the 422 cleanly.
*Flag:* off.

**M29-PR-3 — Explain-with-AI + ghost-preview/replacement-gate interplay tests (dark).**
*Scope:* Add "Explain this with AI" (→ `submit('Explain measure N')` → converse stream text bubble); integration tests for the proposal-clobber-on-resubmit, replacement-gate-vs-ghost-preview ordering, and "Regenerate on tiny score trips the gate" cases.
*Acceptance:* "Explain measure 3" streams text, mutates no score, skips both gates; right-click→"Edit with AI" while a proposal is pending stashes the prior proposal (matches typing a new prompt); regenerate-on-2-bar-score lands the replacement modal, not a crash.
*Flag:* off.

**M29-PR-4 — (Optional) deterministic `targetRegion` wire + flip ON + docs (M29 complete).**
*Scope:* Add `targetRegion?: {startMeasureIdx, endMeasureIdx}` to `ChatRequest` + `ChatRequestSchema` + `OrchestratorInput` + `ToolDispatchInput`; dispatcher pins `region_replace` args when present (skips LLM bar-parsing); "Regenerate this measure" attaches it for exact routing; flip `NEXT_PUBLIC_SL_CONTEXT_AI` to default-on; re-stamp orchestrator + chat-session cards + env-flags; pin prompt templates with the evals harness.
*Acceptance:* with `targetRegion` set, `region_replace` receives exact indices regardless of prompt phrasing; `eval:smoke` green on the new templates; `pnpm docs:check` clean; trio green.
*Flag:* default-on (`!== 'off'`).

---

## D. Added context → menu rows

Folded into the M27 per-context table (additions in **bold**; primary/default unchanged unless noted):

| Context | Clipboard rows | AI rows | Primary/default change |
|---|---|---|---|
| **Single notehead** | Cut · Copy · **Paste** (if `events` clipboard) | **Edit this with AI…** · Explain this with AI | unchanged (**Delete note**) |
| **Rest** | Cut · Copy · **Paste** (if `events`) | Edit this with AI… | unchanged (**Delete rest**) |
| **Chord-note** | Cut (this pitch) · Copy (this pitch) · **Paste** · **Paste into chord** (Paste-special) | Edit this with AI… | unchanged (**Remove this note from chord**) |
| **Whole measure** | Cut · Copy · **Paste** (insert after) · **Replace measure** (Paste-special, if `measures`) | **Regenerate this measure** · Edit this with AI… · Explain this with AI | **was "Select measure" → now "Regenerate this measure"** as primary if clipboard empty & AI on; else Select measure |
| **Barline** | — (no clipboard target) | — | unchanged (**Set barline…**) |
| **Empty staff / non-empty bar** | **Paste** (if clipboard non-empty) | **Generate here…** | **"Generate here…"** becomes primary when bar empty |
| **Active multi-measure range** | Cut measures · Copy measures · **Paste over selection** (Paste-special, if `measures`) | **Regenerate these measures** · Explain these measures | unchanged (**Delete measures**) |
| **Blank score** | — | **Generate with AI…** | unchanged |
| **Grand-staff upper/lower** | (inherits target-type rows; resolved `staffIdx` flows into clipboard `sourceMeta` + paste target) | (inherits) | per target |

Paste rows are always present-but-disabled when the clipboard is empty or kind-incompatible (greyed, not hidden) so the affordance is discoverable.

---

## E. New gotchas, tests, flags, docs

**Net-new gotchas — clipboard:**
- **Meter-balance on paste is net-new — there is NO balanced-insert op.** `BalancedOp` is only `reorder/changeDuration/remove`; `insertEventAfter` is a raw splice (no balance, no validate, no id refresh). `applyEdit`→`transformScore` skips `validateScore`, so an unbalanced paste "succeeds" in the editor but fails on the persistence boundary (and trips `applyScore`/`applyBalancedEdit`'s dev-only validate assertion). Paste-events MUST go through the new `pasteEvents` (`measureBalance`-backed) committed via `applyScore`, never raw `insertEventAfter`.
- **Cut-time capacity (`'C|'`)** returns HALF (`meterCapacityIn32nds` → 16, `meterInEighths` → 4) — correct, do NOT "fix"; all paste-balance math inherits it. Store `meter` in `sourceMeta` so paste-into-a-different-meter is detected.
- **Cross-staff / arity-mismatch paste:** `perVoiceContent` indexing is positional (outer 0=primary staff, 1=secondStaff; inner [0]=primary voice, [1..]=extraVoices) and a bundle whose inner length ≠ destination `count` is **silently replaced with meter rests** (`applyStructuralAppendOrInsert`). Clipboard bundles MUST match destination voice/staff arity or content vanishes — guard with `sourceMeta.staffCount/voiceCount` and reject/adapt on mismatch.
- **Undo coalescing is NOT a transaction.** The 500ms `coalesceKey` window merges only repeated *same-key* edits; there's no group-two-different-ops primitive. CUT stays one undo step only because copy is non-mutating and there is exactly one mutating commit — preserve that discipline.
- **Spans don't travel with naive copy.** `score.spans/markers/voltas/jumps` are event-id/measure-index keyed; `dragMeasureRange` duplicate deliberately drops score-level entries and freshens ids. A "copy with slurs" feature must explicitly clone+remap the spans whose both endpoints fall inside the range (M28-PR-5 decision: carry for `measures`, drop for single-event).
- **Dangling ties at run/measure boundaries:** a copied last-of-chain event carries `tied_to_next` pointing at an absent neighbor → `validatePerPitchTies` flags it. Strip/repair trailing ties on copy. Use `isRest`/`isPitchTiedToNext` accessors — never `pitches[0].step === 'rest'`.
- **Fresh ids mandatory on paste** or span endpoints resolve last-write-wins and silently mis-route (no clear error). MOVE preserves ids on purpose; paste/duplicate must freshen.
- **`navigator.clipboard` permission prompts / unavailability:** `writeText` on copy is fire-and-forget (ignore rejection); `readText` on foreign paste can throw/prompt → degrade to "nothing to paste," never block the in-memory path.
- **Pasting into wrong meter / many-measure re-render cost:** `scoreToAbcWithMap` re-runs on every commit — batch a multi-measure paste into ONE `applyScore`/`insertMeasuresAfter`, not N `applyEdit`s.

**Net-new gotchas — AI-entry:**
- **No typed target channel exists** — `submit(text)` takes only a string; routing depends on the dispatcher LLM parsing the prompt. Prompts MUST use 1-based bar numbers (`measure ${measureIdx+1}`) or the LLM double-offsets.
- **Ghost-preview ≠ universal landing:** "Edit/Regenerate" land as proposals; "Generate here"/from-scratch get NO ghost preview (`maybeAttachGhostProposal` no-ops without `editedScore`) and may route to the bounded free-tier handler or the X-Stream-Kind:score sectional stream (commits on done). Don't assume one landing path.
- **Replacement-gate vs ghost-preview ordering** (client checks replacement first); regenerate on a tiny score can trip the gate → different modal. Menu copy must not promise "amber preview."
- **Resubmit clobbers a pending proposal** with no guard — right-click→"Edit with AI" while a proposal is pending abandons it (intentional, matches typing).
- **Streaming / non-interactive guard:** never seed/submit while `streamProgress` is set or `interactive===false` — and the context menu itself already returns `none` then. `edit_intra_measure` throws "model emitted no ops" on a vague prompt → 422; keep seeded prompts specific (include the clicked bar/event).
- **Cost:** each menu AI item is a full orchestrator round-trip (dispatcher classify + handler). Prefer seeding (user reviews before sending) over headless auto-fire for ambiguous targets to avoid wasted dispatch calls.

**New test files:**
- `tests/unit/lib/chat/clipboard.test.ts` — `ClipboardEntry` serializers per selection kind, deep-clone isolation, JSON-mirror round-trip through `validateScore`.
- `tests/unit/lib/music/pasteEvents.test.ts` — balance cases (absorb / shrink / spill / tie-split), cut-time capacity, id-refresh, `validateScore` on every output.
- `tests/integration/clipboardContextMenu.test.tsx` — Cut/Copy/Paste rows, enable/disable predicates, single-undo-step CUT, copy→paste→undo round-trip, Paste-special routing (`addPitchToChord` / `regionReplace`).
- `tests/unit/components/editor/runSelection.test.ts` — intra-measure `RunSelection` + dangling-tie repair.
- `tests/integration/aiContextMenu.test.tsx` — seeded-vs-headless paths, 1-based prompt formatting, proposal landing, replacement-gate-on-tiny-score, proposal-clobber-on-resubmit, "Explain" converse stream.

**New flags + defaults:**
- `NEXT_PUBLIC_SL_CONTEXT_MENU` — existing; default off until M27-PR-6, then kill-switch (`!== 'off'`).
- `NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD` — NEW; default off until M28-PR-5, then `!== 'off'`. Client-read (browser-only gate), precedent `NEXT_PUBLIC_BALANCED_EDITS === 'off'` (confirmed at `state.ts:1339`).
- `NEXT_PUBLIC_SL_CONTEXT_AI` — NEW; default off until M29-PR-4, then `!== 'off'`. Same client-read pattern.

**Additional docs/cards to stamp (re-stamp `last_verified`→date + `verified_against`→HEAD short SHA in the same PR as the code; run `pnpm docs:check`):**
- M28: **`docs/ai-agents/context-cards/music-model.md`** + **`docs/architecture/data-model.md`** (new `ClipboardEntry`, `pasteEvents`, `RunSelection`); **`docs/ai-agents/context-cards/edit-operations.md`** (`pasteEvents` op + balance composition); **`docs/reference/env-flags.md`** (`NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD`); **`docs/subsystems/editor-ui.md`** + its paired card (clipboard rows).
- M29: **`docs/ai-agents/context-cards/orchestrator.md`** (the seed-input → `submit` AI-entry bridge + optional `targetRegion` field, honoring the "When editing X also update Y" contract); **`docs/ai-agents/context-cards/chat-session.md`** (`aiSeed` slot); **`docs/ai-agents/context-cards/ghost-preview.md`** (menu-driven proposals interplay); **`docs/reference/env-flags.md`** (`NEXT_PUBLIC_SL_CONTEXT_AI`). If `targetRegion` ships, also re-stamp the orchestrator card's `source_paths` to cover `ChatRequest`/`ToolDispatchInput`, and pin the prompt templates in **`evals/`** (`evals/README.md` harness).
