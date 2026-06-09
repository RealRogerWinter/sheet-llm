---
title: Notation Editor UI & Interactions
subsystem: editor-ui
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 1729743
source_paths:
  - src/components/ScorePanel.tsx
  - src/components/ScoreStage.tsx
  - src/components/editor/useNoteClickHandler.ts
  - src/components/editor/useNoteDrag.ts
  - src/components/editor/useStaffInteractions.ts
  - src/components/editor/useMeasureRangeSelect.ts
  - src/components/editor/useMeasureRangeDrag.ts
  - src/components/editor/useEditorKeyboard.ts
  - src/components/editor/keyboardShortcuts.ts
  - src/components/editor/staffGeometry.ts
  - src/components/editor/staffResolver.ts
  - src/components/editor/eventAtX.ts
  - src/components/editor/snapTargetAtX.ts
  - src/components/editor/clickInsertSlot.ts
  - src/components/editor/Popover.tsx
  - src/components/editor/ParsedTextPopover.tsx
  - src/components/editor/NoteFloatingMenu.tsx
  - src/components/editor/EditorToolbar.tsx
  - src/components/editor/SubMenu.tsx
  - src/components/editor/useShiftLetterPopover.ts
  - src/components/editor/useVisualObjRegistry.ts
  - src/components/editor/DragPreviewOverlay.tsx
  - src/components/editor/RunSelectionHighlight.tsx
  - src/components/editor/useScoreWheelZoom.ts
  - src/components/editor/contextTarget.ts
  - src/components/editor/ContextMenu.tsx
  - src/components/editor/useScoreContextMenu.ts
  - src/components/editor/contextMenuItems.ts
  - src/components/editor/contextMenuFlag.ts
  - src/lib/editor/prefsStore.ts
related:
  - abc-rendering
  - music-model
  - chat-session
  - command-palette
  - ghost-preview
---

The notation editor is **direct manipulation over the abcjs SVG**: a small
set of mount-once pointer/keyboard hooks hit-test clicks and drags against a
SourceMap-tagged DOM, plus a family of Dorico-style popover editors anchored
to the selected event. abcjs draws an opaque SVG with no semantic handles, so
the editor stamps `data-startchar` onto every note/rest group after each
render and reverse-maps those source positions back to `(staffIdx, voiceIdx,
measureIdx, eventIdx)` through the SourceMap. **DOM order is never trusted for
measure identity** — the SourceMap is the single source of truth for every
X-based resolution. Every gesture ends in a store mutation (`select`,
`applyEdit`, `applyBalancedEdit`, `applyScore`, or a measure-range op); the
store re-derives ABC + SourceMap and re-renders, and the tagging pass re-runs
so the next gesture resolves against fresh geometry.

## Entry points

| Entry | What it owns |
|-------|--------------|
| `src/components/ScorePanel.tsx` | Renders abcjs into `scoreRef`, stamps `data-startchar` (`tagNoteheadsWithStartChar`), wires the 5 interaction hooks + overlays. Gates everything behind `interactive=true`. |
| `src/components/editor/useNoteClickHandler.ts` | The abcjs `clickListener` → selection entry. Built by `ScoreStage`, passed down. |
| `src/components/editor/keyboardShortcuts.ts:mapKey` | The whole shortcut table (pure). |
| `src/components/editor/useScoreContextMenu.ts` | The right-click `contextmenu` listener + ContextMenu-key/Shift+F10 opener → classifies the target (`contextTarget.ts`) and opens the `ContextMenu` (M27). Gated by `NEXT_PUBLIC_SL_CONTEXT_MENU`. |
| `src/components/editor/NoteFloatingMenu.tsx` | Floating toolbar + ~20 popover open-states + Shift-letter + palette-bus wiring hub (~2500 lines). Secondary actions grouped into 5 category `SubMenu`s. On narrow viewports the inline row is capped to the viewport (`max-width` + `overflow-x: auto`) and becomes a single horizontal-scroll strip; `left` is clamped against the *measured* row width via the exported `clampMenuLeft` helper (SHE-13 — was a hardcoded 360px guess that overflowed phones). |
| `src/components/editor/EditorToolbar.tsx` + `SubMenu.tsx` | Above-score controls (setup behind a `SubMenu`) + the reusable category-submenu primitive. |
| `src/components/editor/staffResolver.ts` + `staffGeometry.ts` | The hit-testing / Y→staff / Y→pitch geometry model. |

## Key files

| Path | Role |
|------|------|
| `src/components/ScorePanel.tsx` | Integration host. `renderScore` → `scoreRef`; `tagNoteheadsWithStartChar` reads `visualObj.engraver.selectables`; wires `useEditorKeyboard`/`useMeasureRangeSelect`/`useMeasureRangeDrag`/`useStaffInteractions`/`useNoteDrag` + `DragPreviewOverlay` + `MeasureRangeHighlight` + `RunSelectionHighlight`. |
| `src/components/ScoreStage.tsx` | Parent. Builds `clickListener` via `useNoteClickHandler`; passes `interactive`/`publishVisual`/`reveal` down; crossfades between epochs (outgoing layer passes none of those flags). |
| `src/components/editor/useNoteClickHandler.ts` | Stable abcjs `clickListener`. `elem.startChar` → `resolveClickPosition(editMap)` → `Selection`; refines `pitchIdx` for chords via `pitchFromY` + `nearestPitchIdx`. Exports `nearestPitchIdx`. Bails on `shiftKey` so it doesn't clobber the D2 run-select gesture. |
| `src/components/editor/useNoteDrag.ts` | Pointer drag of single noteheads. Free 2D; on release disambiguates `reorderBalanced` vs `changePitch` vs `select`. ESC cancels. **D2: Shift+click (no-move branch) extends `runSelection`** anchored on the prior selection (`select()` then `selectRun()`); Shift+DRAG remains the octave gesture. Constants below. |
| `src/components/editor/useStaffInteractions.ts` | Empty-staff `mouseup`: deselect, else implicit chord-merge (`addPitchToChord`) or click-to-insert (`smartInsertNote`). Document `mousedown` dismisses selection on outside clicks. Bails on ctrl/meta. |
| `src/components/editor/useMeasureRangeSelect.ts` | Cmd/Ctrl+click (capture `mousedown`) sets a single-bar range; +Shift extends. Resolves bar via `clickInsertSlot`; clears per-event selection. |
| `src/components/editor/useMeasureRangeDrag.ts` | Plain `pointerdown` (capture) on a highlighted bar arms a move-drag; release dispatches `dragMeasureRange` mode `move`. `DRAG_THRESHOLD_PX=4`. Bails on `.abcjs-note`/`.abcjs-rest`. |
| `src/components/editor/useEditorKeyboard.ts` | Keydown on `scoreRef`. Shift+A–G chord-stack; else `mapKey` → store action or op. Routes `changeDuration`/`deleteEvent` through `applyBalancedEdit`; others `applyEdit`. Skips input/textarea/contenteditable. |
| `src/components/editor/keyboardShortcuts.ts` | Pure `mapKey(event, selection, measureRangeSelection)` → `ShortcutResult`. Exports `pitchForStackKey`. `resolveBarTarget` precedence: range > `selection.measureIdx`. |
| `src/components/editor/staffGeometry.ts` | Y→pitch. `TREBLE_LADDER`/`BASS_LADDER`, `getStaffYPositionsFor`/`getStaffYPositions`, `pitchFromY` (clef-aware, viewBox-scaled), `diatonicLadder`, `midiFromStep`. |
| `src/components/editor/staffResolver.ts` | Y→logical staff. `resolveStaffFromY` groups `.abcjs-staff` by `.abcjs-staff-wrapper`, picks the system (gutter-midline-aware via `pickSystemByGutter`) then within-system staff → logical `staffIdx`. Exports `pickBandByY` + `pickSystemByGutter`. Returns `{staffIdx, staffEl, systemEl}`. |
| `src/components/editor/eventAtX.ts` | X→`(staffIdx, measureIdx, eventIdx)`, scoped to a required `systemEl`. Walks `systemEl`'s `[data-startchar]` whose X-band contains clickX; `resolveClickPosition`; optional `staffFilter`. No svg-wide fallback — so an upper-system click can't implicit-merge into a same-clef chord in another system. |
| `src/components/editor/snapTargetAtX.ts` | X(+optional Y)→nearest `SnapTarget {staffIdx, measureIdx, position32nds, clientX, clientY}`. Groups by (staff,voice,measure); front + per-event cumulative-32nds points. 2D euclidean when Y passed. Whole-measure-rest geometry override. Also exports `dragSnapIsReorder` — release classifier: reorder iff the snap left the source event's `[leading, trailing)` slot. |
| `src/components/editor/clickInsertSlot.ts` | X(within `systemEl`)→`{measureIdx (GLOBAL), insertAfterIdx}`. SourceMap is truth; `insertAfterIdx=-1` ⇒ insert-at-front. Used by insert, range-select, range-drag. |
| `src/components/editor/Popover.tsx` | Shared shell: viewport-clamped positioning (prefer below, flip above on clip; horizontal center clamped 8px), Escape-to-close (`stopPropagation`), `mouseDown` containment, `role=dialog`. `DEFAULT_HEIGHT=200`/`WIDTH=320`. |
| `src/components/editor/ParsedTextPopover.tsx` | Generic free-text popover over `Popover` (parser/formatter, Enter-to-submit, Cancel/Apply, optional Clear). Re-seeds input only on false→true open transition. |
| `src/components/editor/NoteFloatingMenu.tsx` | Wiring hub. Toolbar at `selection.anchorX/Y`; one open-state per popover; ~20 `useShiftLetterPopover` bindings; `paletteRequest` dispatch-bus subscriber; measure-scoped target snapshots. Inline row = Play / accidentals / durations / Add / Delete / chord section; everything else lives in 5 category `SubMenu`s (Articulation, Expression, Text, Lines, Structure) driven by one `activeSubmenu` value. A submenu button that opens a dedicated popover routes through `openFromSubmenu` (closes the submenu first so the popover anchors at the selection, not behind the panel); plain toggles keep the submenu open. Keyboard shortcuts are unchanged — they fire via `useShiftLetterPopover` regardless of which submenu a button now lives in. |
| `src/components/editor/EditorToolbar.tsx` | Above-score controls. Note picker / +Measure/+Note/+Chord / Undo-Redo-Reset / Score-info stay inline; Key/Meter/Tempo/Staves/Clef/Voices moved verbatim into a single "Setup" `SubMenu` (`column` layout). |
| `src/components/editor/SubMenu.tsx` | Reusable category submenu on `Popover`. A labeled, caret'd trigger captures its `getBoundingClientRect` in the click handler (never during render — `react-hooks/refs`) into state, then opens a `Popover` anchored beneath it. `layout='grid'` (action buttons) or `'column'` (labeled selects/inputs). One-open-at-a-time is the parent's responsibility via `activeSubmenu`. |
| `src/components/editor/useShiftLetterPopover.ts` | Binds a Shift+letter combo (capture-phase document keydown) to a popover opener; `preventDefault`+`stopPropagation` so it preempts the bubble-phase chord-stack handler. Guards input/textarea/contenteditable. `open` captured by ref. |
| `src/components/editor/useVisualObjRegistry.ts` | `useSyncExternalStore` module registry: `publishVisualObj(visualObj)` / `useCurrentVisualObj` — keeps the large `visualObj` out of React state. |
| `src/components/editor/DragPreviewOverlay.tsx` | Fixed green vertical line at `dragSnapTarget.clientX`. Subscribes only to `dragSnapTarget`. |
| `src/components/editor/useScoreWheelZoom.ts` | Native `{passive:false}` `wheel` listener (mounted on the score area in `Hero`) that steps zoom on **Ctrl/⌘ + scroll** and trackpad **pinch** (browsers synthesize `ctrlKey`). `preventDefault`s to suppress the browser's native page zoom; plain wheel is left alone so the page still scrolls. Delta-accumulated stepping (`STEP_THRESHOLD_PX=100`, deltaMode-normalized); reads the store via `getState()` so the listener stays stable across zoom changes. |
| `src/lib/editor/prefsStore.ts` | Zustand zoom store. `ZOOM_LEVELS [0.5,0.75,1.0,1.25,1.5,1.75,2.0,2.5,3.0]`, `DEFAULT_ZOOM=1.0`, `NATIVE_STAFFWIDTH=740`; `staffwidthForZoom(z)=round(740/z)` maps a zoom level to an abcjs layout `staffwidth` — zoom is REFLOW-based, NOT abcjs `scale` (see `abc-rendering`), so it never overflows horizontally. localStorage `sheet-llm:editor:zoom`; `useEditorPrefsSync` hydrates on mount. |

`useNoteDrag` constants: `DEAD_ZONE_PX=4`, `MIN_MOVE_PX=12`, `MAX_STEPS=14`,
`MAX_OCTAVES=2`. `useMeasureRangeDrag`: `DRAG_THRESHOLD_PX=4`.

## Core concepts & data flow

### SourceMap-tagged DOM (`data-startchar`)

All hit-testing keys off `[data-startchar]` attributes that
`ScorePanel.tagNoteheadsWithStartChar` stamps onto note **AND** rest SVG
groups after each render, reading the **undocumented** abcjs internal
`visualObj.engraver.selectables` (each `sel.absEl.abcelem.startChar` +
`sel.svgEl`). `resolveClickPosition(editMap, startChar)` reverse-maps a
startChar to `(staffIdx, voiceIdx, measureIdx, eventIdx)`. This is the single
source of truth for every X-based resolution. Tagging only runs when
`interactive=true`.

### Logical-staff resolution

abcjs emits one `.abcjs-staff` per (system × logical staff), so the raw DOM
index ≠ logical staff. `resolveStaffFromY` groups staves by
`.abcjs-staff-wrapper` (one wrapper per system), picks the system then the
within-system staff band; the within-system position **is** the logical
`staffIdx`, clamped to `[0, staffCount-1]`. The system pick is gutter-aware
(`pickSystemByGutter`): a click inside a system's band wins by containment, and
a click in the empty gutter between systems is awarded by the gutter **midline**
— not nearest band-center, which is biased by differing system heights and can
hand a high-note / ledger-line click (`.abcjs-staff` boxes are staff-lines-only)
to the wrong line. Callers must pass the resolved `staffEl` to `pitchFromY` and
the `systemEl` to **both** `clickInsertSlot` and `eventAtX`, or grand-staff /
multi-system clicks route to the wrong staff/measure (e.g. an empty-space click
in an upper system implicit-merging into a lower system's chord). There is a
legacy fallback that groups `.abcjs-staff` by direct parent when no wrapper is
present.

### Clef-aware Y→pitch

`pitchFromY` scales `clickClientY` through the SVG viewBox, reads the 5
staff-line Y-positions of the specific `staffEl`, computes
`stepHeight=(line4-line0)/8`, and indexes into `TREBLE_LADDER` or
`BASS_LADDER` (clamped). Accidentals never change notehead Y, so chord
`pitchIdx` refinement uses `midiFromStep` distance ignoring accidentals
(`nearestPitchIdx`).

### Mount-once hooks + `getState()`

`useStaffInteractions`, `useNoteDrag`, `useMeasureRangeDrag`,
`useMeasureRangeSelect` attach listeners in a `useEffect` keyed only on
`[scoreRef]`; all store reads happen via `useChatStore.getState()` inside the
handlers, so the listener set never tears down on every edit or selection
change. (`useEditorKeyboard` is the exception — it depends on `selection`/
`measureRangeSelection`/actions and re-attaches when those change.)

### Gesture arbitration

```
                    plain                 Cmd/Ctrl            Cmd/Ctrl+Shift
  on a notehead  →  useNoteDrag drag /    (n/a — note         (n/a)
                    clickListener select   handler ignores
                                           modifiers)
  on a highlighted
  bar (not note) →  useMeasureRangeDrag    useMeasureRange-    useMeasureRange-
                    move                   Select single bar   Select extend
  on empty staff →  useStaffInteractions   useMeasureRange-    useMeasureRange-
                    insert / deselect      Select single bar   Select extend
```

`Alt` held during an empty-staff click forces a new event (skips implicit
chord-merge). Capture-phase listeners + explicit `.abcjs-note`/`.abcjs-rest`
bail-outs keep these from double-firing.

### Reorder-vs-pitch disambiguation (`useNoteDrag`)

`useNoteDrag` is free 2D — the notehead follows the pointer in both axes so
the user can drag diagonally to a bar on the next system. On release,
`dragSnapIsReorder` (in `snapTargetAtX.ts`) classifies the live snap target
against the source event's **own slot** `[leadingPos, trailingPos)`, computed
from `cumulativeBoundaries(getVoiceMeasureAt(...).events)`:

- snap on a different measure (incl. another system), or a beat in the source
  measure that is **neither** the leading nor the trailing boundary →
  `reorderBalanced` to that target, then the selection is moved to the dropped
  event via `computeReorderSelection`.
- snap on **either** of the source event's own boundaries (leading or
  trailing) → `changePitch` by `round(dy / stepPx)` steps (`shift` = octave,
  clamped to `MAX_STEPS`/`MAX_OCTAVES`).
- movement under `MIN_MOVE_PX` → treat as click → `select`.

Matching **both** own-boundaries is load-bearing: a straight-down pitch drag
keeps the pointer over the notehead center, and `snapTargetAtX` scores by 2D
distance, so it returns whichever own-boundary is nearer — almost always the
**trailing** one (the leading boundary sits at the previous note's right edge,
farther from center). Matching only the leading boundary misread nearly every
vertical drag as a reorder, so notes refused to retune — the historical
"can't reliably drag a note up/down to change pitch" bug.

During `pointermove` it also strips the live `transform` off the dragged
notehead before `snapTargetAtX` measures, then restores it, so the source's
boundaries keep their original Y (one layout thrash per move; see gotchas).

### Dorico-style popovers

`NoteFloatingMenu` binds ~20 Shift+letter combos to popover open-states:

```
D dynamics   P technique   F fingering   O ornament   R grace(R for gRace)
T text       M marker      H harmony     W hairpin     S slur     I tie
L tempo      U octave      G gliss       Z trill-line  X tremolo  V lyrics
J barline    K volta       Y jump-marker
```

Span popovers (hairpin/slur/tempo/octave/gliss/trill/tremolo) are gated on
`selectedEvent?.id !== undefined`; ties/lyrics/marker/etc. are not. Two
popover families share `Popover.tsx`: **text-input** popovers wrap
`ParsedTextPopover<T>` (parser/formatter, e.g. `DynamicsPopover`);
**button-grid** popovers (e.g. `OrnamentMenuPopover`) emit a discriminated
`patch` union via `onPatch`, and the call site in `NoteFloatingMenu` maps each
patch to its edit op while reading fresh store state to avoid closure
staleness.

### Command-palette dispatch bus

`NoteFloatingMenu` subscribes to `store.paletteRequest`; on an `open-*` kind it
sets the matching popover's target snapshot **then** flips its open flag, and
calls `setPaletteRequest(undefined)` to consume it. Unknown kinds
(`open-score-info`) are left in the slot for `EditorToolbar`. See the
`command-palette` context card.

### End-to-end flow

```
pointer/key on scoreRef (role=application, tabIndex=0)
  ├─ note click → abcjs clickListener (useNoteClickHandler)
  │     elem.startChar → resolveClickPosition → Selection
  │     (chord: pitchFromY + nearestPitchIdx) → store.select()
  ├─ empty-staff mouseup (useStaffInteractions)
  │     resolveStaffFromY → pitchFromY; eventAtX (merge) or
  │     clickInsertSlot → addPitchToChord | smartInsertNote→applyScore
  ├─ keydown (useEditorKeyboard) → mapKey/pitchForStackKey →
  │     applyEdit | applyBalancedEdit | store action
  ├─ notehead drag (useNoteDrag) → snapTargetAtX live (publishes
  │     dragSnapTarget) → reorderBalanced | changePitch on release
  └─ range select/drag → clickInsertSlot → measure-range ops
                                    │
                store.selection / measureRangeSelection / editedScore
                                    │
   NoteFloatingMenu renders toolbar@anchorX/Y + popover layer;
   MeasureRangeHighlight reads measureRangeSelection + measureDragState
                                    │
   every edit mutates editedScore → re-derive ABC+SourceMap(editMap)
   → ScorePanel re-render → tagNoteheadsWithStartChar re-stamps
```

## Invariants & gotchas

- **Tagging depends on an undocumented abcjs internal.**
  `tagNoteheadsWithStartChar` reads `visualObj.engraver.selectables`
  (`absEl.abcelem.startChar` + `svgEl`). If abcjs (expected `^6.6.x`) changes
  that shape, the `Array.isArray` guard bails: dev logs a `console.warn`, prod
  silently disables drag/select (notes still render). Tagging happens only
  when `interactive=true`.
- **Rests MUST carry `data-startchar` too** (tagged on `el_type` `'note'` OR
  `'rest'`) so `snapTargetAtX`'s cumulative-32nds boundary sum doesn't skip
  rest durations and land cross-measure reorders on the wrong boundary. Rests
  are not draggable — `useNoteDrag`'s `pointerdown` filters on `.abcjs-note`
  only; rests carry `.abcjs-rest` and act purely as snap anchors.
- **`useNoteDrag` strips+restores the transform per `pointermove`.** Without
  the strip, the source's trailing snap point follows the pointer Y and a
  pure-vertical drag wrongly routes to `reorderBalanced` instead of
  `changePitch`. One layout thrash per move; the visual feedback is unchanged.
- **Range-drag vs notehead-drag double-dispatch.** `useMeasureRangeDrag` and
  `useNoteDrag` both listen for plain `pointerdown`; the range-drag hook runs
  in **capture** phase and explicitly bails when the target is inside
  `.abcjs-note`/`.abcjs-rest`. Without that bail, dragging a note inside a
  highlighted range fires **both** `reorderBalanced` AND
  `dragMeasureRange`-move on one `pointerup`, corrupting score state and undo
  history.
- **`useStaffInteractions` mouseup gates out ctrl/meta** because
  `useMeasureRangeSelect`'s `mousedown.stopPropagation` does NOT stop the
  subsequent `mouseup` — without the gate a Cmd+click would also insert an
  unwanted note.
- **Span popovers soft-deadlock without an event id.** Opening a span popover
  (hairpin/slur/tempo/octave/gliss/trill/tremolo) on an id-less event leaves
  its render guard returning null while the open flag stays true and `Popover`
  suppresses Escape. `NoteFloatingMenu` therefore disables those buttons and
  gates the Shift+letter binding on `selectedEvent?.id !== undefined`.
- **`useShiftLetterPopover` registers in capture phase** specifically so it can
  `stopPropagation` before `useEditorKeyboard`'s bubble-phase Shift+letter
  chord-stack handler runs; otherwise Shift+D both stacks a D and opens
  dynamics. Letters that double as chord-stack letters (e.g. Shift+G
  glissando) rely entirely on this ordering.
- **Measure-scoped popovers snapshot their target at open time.** Barline /
  volta / jumpMarker / marker capture their measure into local state when they
  open. Without the snapshot, a mid-open selection change would route
  Apply/auto-emit patches to the live measure rather than the one displayed.
- **`mapKey` returns raw `changeDuration`/`deleteEvent`;**
  `useEditorKeyboard` rewrites them to `changeDurationBalanced` /
  `removeBalanced` and routes through `applyBalancedEdit`, because
  `transformScore` (used by `applyEdit`) is meter-blind and would leave the
  bar short by the duration delta.
- **`snapTargetAtX` groups by (staffIdx, voiceIdx, measureIdx)** and resets the
  cumulative-32nds counter per group — extra voices share horizontal space, so
  grouping them would double-count durations and emit snap points at wrong
  offsets. It also overrides the right-edge `clientX` for whole-measure rests
  (abcjs centers the glyph) using the next measure's first-event left edge.
- **Zoom is an explicit ladder.** `useEditorPrefsSync` silently falls back to
  `DEFAULT_ZOOM` (1.0) for off-ladder localStorage values and only dispatches
  when the stored value differs from the default (avoids a wasted
  `ScorePanel` re-render). `ScorePanel`'s render key is `` `${zoom} ${abc}` ``
  so a zoom-only change still re-renders.
- **`ScorePanel.tsx` contains a NUL byte (~offset 5217)** that makes ripgrep
  treat it as binary; use `Read` (not `Grep`) on that file.

## How to extend / common tasks

- **Add a keyboard shortcut:** add a branch to `mapKey` in
  `keyboardShortcuts.ts` returning a `StoreAction` or `{op, coalesce}`, then
  handle any new `StoreAction.kind` in `useEditorKeyboard`'s switch. If the op
  changes a bar's duration, route it through `applyBalancedEdit` there.
- **Add a text-input popover:** wrap `ParsedTextPopover<T>` with a
  parser/formatter, render it in `NoteFloatingMenu`, add an open-state and a
  `useShiftLetterPopover` binding, and put its trigger button inside the right
  category `SubMenu` (call `openFromSubmenu` so the submenu closes before the
  popover opens). For span-type edits, gate `enabled` on
  `selectedEvent?.id !== undefined` and disable the trigger button.
- **Add a button-grid popover:** emit a discriminated `patch` union via
  `onPatch`; map each patch to an edit op at the `NoteFloatingMenu` call site,
  reading `useChatStore.getState()` for the live selection. Place its trigger in
  the appropriate `SubMenu` category.
- **Add a category submenu (or move a button between categories):** the
  category set + membership live in `NoteFloatingMenu`'s inline-row JSX; each is
  a `SubMenu` keyed off the shared `activeSubmenu` state. Reuse `SubMenu` rather
  than adding a bespoke popover for grouping.
- **Wire it to the command palette:** add an `open-*` `paletteRequest` kind and
  a `case` in the `NoteFloatingMenu` palette effect; set any target snapshot
  before flipping the open flag.
- **Touch hit-testing geometry:** changes to `data-startchar`, ladders, or the
  staff/system grouping ripple through `eventAtX`, `snapTargetAtX`,
  `clickInsertSlot`, `pitchFromY`, and `resolveStaffFromY` — re-verify the
  grand-staff and multi-system paths.

## Testing

- `tests/unit/components/editor/keyboardShortcuts.test.ts` — `mapKey` table.
- `tests/unit/components/editor/useEditorKeyboard.test.tsx`,
  `useShiftLetterPopover.test.tsx`, `useMeasureRangeDrag.test.tsx` — hook
  behavior.
- `tests/unit/components/editor/snapTargetAtX.test.ts`, `eventAtX.test.ts`,
  `clickInsertSlot.test.ts`, `nearestPitchIdx.test.ts`,
  `snapAfterTransform.regression.test.ts` — hit-testing (the last pins the
  strip-measure-restore behavior).
- `tests/unit/editor/staffResolver.test.ts`, `staffGeometry.test.ts`,
  `prefsStore.test.ts` — geometry + zoom store (`prefsStore.test.ts` also pins
  `staffwidthForZoom`).
- `tests/unit/components/editor/useScoreWheelZoom.test.tsx` — Ctrl/⌘/pinch wheel
  zoom, delta accumulation, deltaMode normalization, plain-wheel pass-through.
- `tests/unit/components/editor/Popover.test.tsx`,
  `ParsedTextPopover.test.tsx`, and per-popover `*.test.tsx`
  (Dynamics/Ornament/Technique/Fingering/Hairpin/Slur/Tie/Volta/Marker/…).
- `tests/unit/components/editor/NoteFloatingMenu.markings.test.tsx`,
  `paletteRequest.test.tsx`, `MeasureRangeHighlight.test.tsx`,
  `durationEdit.regression.test.ts`.

## Related files / See also

- `src/lib/music/scoreToAbcWithMap.ts` (`resolveClickPosition`, `SourceMap`) —
  the reverse-map every hit-test depends on. See the `abc-rendering` card.
- `src/lib/music/smartInsertNote.ts` — rest-absorbing insertion used by
  click-to-place.
- `src/lib/music/measureBalance.ts` (`DURATION_32NDS`) and
  `src/lib/music/meter.ts` (`meterCapacityIn32nds`) — duration math behind
  snap boundaries.
- `src/lib/chat/state.ts` — `select`, `applyEdit`, `applyBalancedEdit`,
  `applyScore`, `selectMeasureRange`, `setDragSnapTarget`,
  `setMeasureDragState`, `paletteRequest`. See the `chat-session` card.
- `src/components/editor/MeasureRangeHighlight.tsx` — the range/drag overlay.
- `src/components/editor/RunSelectionHighlight.tsx` — the D2 intra-measure run-select overlay (green; one box over the run's events).
- `docs/ai-agents/context-cards/editor-ui.md` — the compact agent card.
