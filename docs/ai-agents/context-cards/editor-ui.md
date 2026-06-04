---
title: Editor UI & Interactions — Context Card
subsystem: editor-ui
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
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
  - src/components/editor/MeasureDeleteConfirmModal.tsx
  - src/components/editor/EditorToolbar.tsx
  - src/components/editor/SubMenu.tsx
  - src/components/editor/useShiftLetterPopover.ts
  - src/components/editor/useScoreWheelZoom.ts
  - src/components/editor/contextTarget.ts
  - src/components/editor/ContextMenu.tsx
  - src/components/editor/useScoreContextMenu.ts
  - src/components/editor/contextMenuItems.ts
  - src/components/editor/contextMenuFlag.ts
  - src/components/editor/contextMenuClipboard.ts
  - src/components/editor/contextMenuAi.ts
  - src/components/editor/RunSelectionHighlight.tsx
  - src/components/editor/systemClipboard.ts
  - src/lib/chat/clipboard.ts
  - src/lib/music/pasteEvents.ts
  - src/lib/editor/prefsStore.ts
related:
  - abc-rendering
  - music-model
  - chat-session
  - command-palette
  - ghost-preview
---

Direct-manipulation editor over the abcjs SVG: mount-once pointer/keyboard hooks hit-test against a SourceMap-tagged DOM, plus Dorico-style popovers anchored to the selected event. **DOM order is never trusted for measure identity — SourceMap is.**

## Key files
- `ScorePanel.tsx` — host. `renderScore`→`scoreRef`; `tagNoteheadsWithStartChar` stamps `data-startchar` on note+rest groups from `visualObj.engraver.selectables`; wires 5 hooks + overlays. Gated on `interactive=true`.
- `ScoreStage.tsx` — parent; builds `clickListener`, passes `interactive`/`publishVisual`/`reveal`; epoch crossfade.
- `editor/useNoteClickHandler.ts` — abcjs clickListener → `Selection`; chord `pitchIdx` via `pitchFromY`+`nearestPitchIdx`. Exports `nearestPitchIdx`. **Bails on `mouseEvent.shiftKey`** so abcjs's click doesn't clobber the D2 run-select gesture (owned by `useNoteDrag` pointerup).
- `editor/useNoteDrag.ts` — notehead drag; release → `reorderBalanced` | `changePitch` | `select`. Reorder iff snap left source's `[leading,trailing)` slot, else `changePitch` by `round(dy/stepPx)`. `DEAD_ZONE_PX=4 MIN_MOVE_PX=12 MAX_STEPS=14 MAX_OCTAVES=2`. **D2: Shift+click (no-move branch) extends a `runSelection`** from the prior single selection to the clicked event (same voice+measure) — `select()` then `selectRun()`. Shift+DRAG stays the octave gesture (move branch), unaffected.
- `editor/useStaffInteractions.ts` — empty-staff mouseup: deselect / `addPitchToChord` (merge) / `smartInsertNote`. Bails ctrl/meta.
- `editor/useMeasureRangeSelect.ts` — Cmd/Ctrl+click bar (capture mousedown), +Shift extends.
- `editor/useMeasureRangeDrag.ts` — plain pointerdown on highlighted bar → `dragMeasureRange` move. `DRAG_THRESHOLD_PX=4`. Bails `.abcjs-note/.abcjs-rest`.
- `editor/keyboardShortcuts.ts` — pure `mapKey(event, selection, range)`→`ShortcutResult`; `pitchForStackKey`; `resolveBarTarget` (range > selection). Measure deletes (Shift+Delete/Backspace always; plain Delete/Backspace when a range is set with NO per-event selection) return a `requestMeasureDelete` StoreAction → the always-confirm gate, never a direct op; plain Delete with an event selected stays per-event.
- `editor/useEditorKeyboard.ts` — keydown→Shift+A–G stack / `mapKey`→`applyEdit`/`applyBalancedEdit`/action.
- `editor/staffResolver.ts` — `resolveStaffFromY`→`{staffIdx,staffEl,systemEl}` (system pick gutter-midline-aware); `pickBandByY`, `pickSystemByGutter`.
- `editor/staffGeometry.ts` — `pitchFromY` (clef-aware, viewBox-scaled), `TREBLE/BASS_LADDER`, `midiFromStep`.
- `editor/eventAtX.ts` / `snapTargetAtX.ts` / `clickInsertSlot.ts` — X→event (scoped to `systemEl`) / X→`SnapTarget` (+`dragSnapIsReorder` release classifier) / X→`{measureIdx(GLOBAL),insertAfterIdx}`.
- `editor/NoteFloatingMenu.tsx` (~2500 ln) — floating toolbar@`anchorX/Y`, ~20 popover open-states, Shift-letter + `paletteRequest` bus, measure-target snapshots. Inline row = Play / accidentals / durations / Add / Delete (event) / chord; the rest grouped into 5 category `SubMenu`s (Articulation, Expression, Text, Lines, Structure) via a single `activeSubmenu` state. The Structure submenu's 🗑 button deletes the whole measure (or the active `measureRangeSelection`) via the always-confirm gate — `store.requestMeasureDelete` → `MeasureDeleteConfirmModal`; distinct from the inline ⌫ which removes the selected *event*. Buttons that open a dedicated popover close their submenu first (`openFromSubmenu`).
- `editor/EditorToolbar.tsx` — above-score controls. Note picker / +Measure/+Note/+Chord / Undo-Redo-Reset / Score-info stay inline; Key/Meter/Tempo/Staves/Clef/Voices moved into a single `SubMenu` ("Setup", column layout).
- `editor/SubMenu.tsx` — reusable category submenu on the `Popover` shell: labeled caret trigger captures its rect on click → anchored popover with a `grid` (buttons) or `column` (labeled selects) panel. One-open-at-a-time is the parent's job (`activeSubmenu`).
- `editor/Popover.tsx` / `ParsedTextPopover.tsx` — shell (clamp, Esc-stopProp) / text-input variant.
- `editor/MeasureDeleteConfirmModal.tsx` — always-confirm gate for whole-measure deletion. Renders on `store.pendingMeasureDelete`; Esc/backdrop cancel, Enter/Delete confirm → `confirmMeasureDelete` fires a `dragMeasureRange` delete. Mounted in `Hero.tsx`. Both measure-delete entry points (this card's 🗑 button + the ⌘K `delete-measure` cmd) funnel through it.
- `editor/useShiftLetterPopover.ts` — capture-phase Shift+letter→opener; preempts chord-stack.
- `lib/editor/prefsStore.ts` — zoom store + `staffwidthForZoom(z)=round(NATIVE_STAFFWIDTH/z)` (740). Zoom is REFLOW (drives abcjs `staffwidth`, NOT `scale`) so it never h-overflows — see `abc-rendering`.
- `editor/useScoreWheelZoom.ts` — Ctrl/⌘ + wheel & trackpad pinch (synthesized `ctrlKey`) step the zoom ladder. Native `{passive:false}` wheel listener mounted on the score area in `Hero`; `preventDefault`s to suppress native page zoom; plain wheel still scrolls. Delta-accumulated; reads store via `getState()`.
- `editor/contextTarget.ts` / `ContextMenu.tsx` / `useScoreContextMenu.ts` / `contextMenuItems.ts` — **right-click context menu (M27)**. `useScoreContextMenu(scoreRef,enabled)` mounts a `contextmenu` listener (+ a ContextMenu-key/Shift+F10 opener) on the interactive ScorePanel; `classifyContextTarget` composes `resolveStaffFromY`→`clickInsertSlot`/`data-startchar`→`pitchFromY` into a tagged `ContextTarget` (note/rest/chordNote/measure/barline/range/empty/none — SourceMap is truth, `systemEl`-scoped). `ContextMenu` (anchor-keyed panel, `role=menu`, `aria-activedescendant` roving) renders `contextMenuSections(target,{eventHasId})` and routes each item to the SAME store actions the toolbar uses (`applyEdit`/`applyBalancedEdit`/`playFromSelection`/`requestMeasureDelete`/the `paletteRequest` bus). Reads the `contextMenu` store slot; `NoteFloatingMenu` suppresses its toolbar render while it's set. Gated by `isContextMenuEnabled()` (`contextMenuFlag.ts`). Coexists with the left-click toolbar.

## Types/exports
`Selection`, `MeasureRangeSelection`, `RunSelection` (`@/lib/chat/state`); `Operation` (`@/lib/music/editOperations`); `SnapTarget`; `ShortcutResult = {op,coalesce} | StoreAction | null`; `resolveClickPosition`/`SourceMap` (`@/lib/music/scoreToAbcWithMap`); `DURATION_32NDS` (`@/lib/music/measureBalance`).

## Env flags / constants
- `NEXT_PUBLIC_SL_CONTEXT_MENU` (`contextMenuFlag.ts`) — default-ON kill switch for the right-click context menu; exactly `'off'` disables it (any other value, incl. unset, enables). Mirrors `NEXT_PUBLIC_BALANCED_EDITS`.
- `NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD` (`contextMenuFlag.ts`) — **M28** default-ON kill switch for the context-menu Cut/Copy/Paste rows. Clipboard = in-memory `clipboard` store slot + `clipboard.ts` copy serializers (`copyEventSelection`/`copyEventRun`/`copyMeasureRange`, deep-cloned) + `pasteEvents.ts` (balanced rest-space insert; **D1: spills over-long pastes into new meter-valid bars** via `packEventsIntoMeasures`+`tieSplitOver`) / `pasteMeasuresInsertOp`/`pasteMeasuresReplaceOp`; `contextMenuClipboard.runClipboardItem` dispatches (Cut = copy + one delete). **D2 run-select**: when `runSelection` covers the right-clicked event, Copy/Cut act on the whole run — `copyEventRun` (strips the trailing dangling tie) / `removeEventRun` (replaces with rests, meter-preserving, one `applyScore`); the green `RunSelectionHighlight` overlay shows the span. **D3 system-clipboard mirror** (`systemClipboard.ts`): Copy also writes tagged JSON via `navigator.clipboard.writeText` (best-effort, all failures swallowed); paste prefers the in-memory slot and falls back to `readSystemClipboardEntry` (parsed by `clipboardEntryFromJSON`, marker-gated) so a copy in one tab/session pastes in another — `runClipboardItem` is async for that fallback only. In-memory slot stays canonical. **D4 span-carry on measure copy/paste**: `copyMeasureRange` captures the spans FULLY inside the range (`spansFullyInsideRange`, editOperations); the paste-op builders clone via `cloneCapturedRangeWithFreshIdsMapped` (returns the old→new event-id map), `remapSpansToFreshIds` rewrites the endpoints, and `insertMeasuresAfter`/`regionReplace` append them via their new optional `spansToAdd`. Spans straddling the range boundary are left behind.
- `NEXT_PUBLIC_SL_CONTEXT_AI` (`contextMenuFlag.ts`) — **M29** default-ON kill switch for the context-menu AI rows (Edit-with-AI / Regenerate / Explain). **Seed-only**: `contextMenuAi.runAiItem` pre-fills a 1-based target-scoped prompt into the chat input via the `aiSeed` bus (`seedAiInput`; PromptBar subscribes); the user sends, and the request flows through the normal pipeline + M24 ghost preview unchanged. **D5 deterministic targetRegion**: the AI items ALSO attach the exact 0-based measure region (`aiSeed.targetRegion`); PromptBar arms it on seed and attaches it to the next submit while the input still derives from the seed (startsWith guard) → `useSubmitPrompt` → `ChatRequest.targetRegion` → `OrchestratorInput` → `ToolDispatchInput`, where `buildRegionHint` injects a "SELECTED REGION" line (1-based label + 0-based indices) into the dispatch prompt. Additive + optional; absent ⇒ the prose-only path.
- `ZOOM_LEVELS [0.5,0.75,1.0,1.25,1.5,1.75,2.0,2.5,3.0]`, `DEFAULT_ZOOM=1.0`, `NATIVE_STAFFWIDTH=740`, localStorage `sheet-llm:editor:zoom`. Wheel/pinch `STEP_THRESHOLD_PX=100`.
- `Popover` `DEFAULT_HEIGHT=200 WIDTH=320`.

## Top gotchas
1. Tagging reads UNDOCUMENTED `visualObj.engraver.selectables` (abcjs `^6.6.x`); shape change → dev warn, prod silently disables drag/select. Only when `interactive=true`.
2. Rests MUST carry `data-startchar` (snap cumulative-32nds), but are NOT draggable (`useNoteDrag` filters `.abcjs-note`).
3. Release classifier (`dragSnapIsReorder`) counts BOTH the source event's leading AND trailing boundary as "in slot" → `changePitch`; matching only leading misroutes vertical drags (snap hits the nearer trailing edge) to reorder — the historical "can't drag notes up/down" bug. `useNoteDrag` also strips+restores the transform before each `snapTargetAtX` measure.
4. `useMeasureRangeDrag` runs capture-phase + bails on `.abcjs-note/.abcjs-rest`, else double-dispatch (reorder + range-move) corrupts undo.
5. Span popovers (hairpin/slur/tempo/octave/gliss/trill/tremolo) soft-deadlock on id-less events → gated on `selectedEvent?.id !== undefined`.
6. `mapKey` returns raw `changeDuration`/`deleteEvent`; `useEditorKeyboard` rewrites to `*Balanced` (transformScore is meter-blind).
7. `ScorePanel.tsx` has a NUL byte (~5217) — use Read, not Grep.

## When editing X, also update Y
- New `StoreAction.kind` in `keyboardShortcuts.ts` → handle in `useEditorKeyboard` switch.
- New popover → open-state + `useShiftLetterPopover` + (optional) `paletteRequest` `open-*` case + a trigger button inside the relevant `SubMenu` category in `NoteFloatingMenu` (close the submenu via `openFromSubmenu` before opening the dedicated popover); span-type → gate `enabled` on event id.
- `data-startchar` / ladder / staff-grouping changes ripple through `eventAtX` + `snapTargetAtX` + `clickInsertSlot` + `pitchFromY` + `resolveStaffFromY`; re-verify grand-staff/multi-system.
- Multi-staff callers MUST pass resolved `staffEl` to `pitchFromY` and `systemEl` to BOTH `clickInsertSlot` and `eventAtX` (else an upper-system click merges into a lower system's chord).
- New right-click menu verb → add it to `contextMenuSections` (the right per-kind section; a `bus:open-*` id for popover verbs reuses the `NoteFloatingMenu` subscriber with NO new wiring; span verbs gate on `eventHasId`) and, for non-bus actions, a `run()` branch in `ContextMenu`.

## Related cards
`abc-rendering`, `music-model`, `chat-session`, `command-palette`, `ghost-preview`
