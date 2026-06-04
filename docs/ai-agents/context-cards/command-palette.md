---
title: Command Palette (Cmd-K) — context card
subsystem: command-palette
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/components/editor/commandCatalog.ts
  - src/components/editor/CommandPalette.tsx
  - src/components/editor/useCommandPalette.ts
  - src/lib/chat/state.ts
  - src/components/editor/NoteFloatingMenu.tsx
  - src/components/editor/EditorToolbar.tsx
  - src/components/Hero.tsx
related:
  - chat-store-state
  - note-floating-menu
  - editor-toolbar
  - popover-shell
  - ghost-preview-proposal
---

Cmd-K/Ctrl-K palette: fuzzy, category-grouped editor commands. Each command's `action` either mutates the chat-store directly or publishes a nonce-stamped `PaletteRequest` onto a single-slot bus that popover-owning components subscribe to and open.

## Files
- `src/components/editor/commandCatalog.ts` — `PaletteCommand`, `COMMAND_CATALOG` (36 cmds), helpers `applyAvailabilityFilter` / `fuzzyFilterCommands` / `groupCommandsByCategory`; `filterCommands` exists but UI-unused.
- `src/components/editor/CommandPalette.tsx` — UI (default export). Centered `Popover`, search + grouped list, arrow/Enter nav. Props `{ open; onClose; commands? }`.
- `src/components/editor/useCommandPalette.ts` — `useCommandPalette(onOpen)`: capture-phase doc keydown for Ctrl/Cmd+K.
- `src/lib/chat/state.ts` — `PaletteRequest` union (21 `{kind;nonce}` arms), bus slot `paletteRequest`, `setPaletteRequest` (auto-bumps nonce).
- `src/components/editor/NoteFloatingMenu.tsx` — bus subscriber for 20 selection-anchored kinds (effect ~256-335); clears slot; `open-score-info` falls through default.
- `src/components/editor/EditorToolbar.tsx` — bus subscriber for `open-score-info` only (effect ~113-126).
- `src/components/Hero.tsx` — mounts palette; local `paletteOpen` state (NOT in store); hook at line 60, mount at line 99.
- `src/components/editor/Popover.tsx` — shell: viewport clamp + owns Esc-to-close.

## Key types/exports
- `PaletteCommand { id; label; keybind?; hint?; action(store); available?(store) }` — `keybind` display-only; `hint` = filterable text AND `"Category / Sub"` group source. `StoreSnapshot = ReturnType<typeof useChatStore.getState>`.
- `applyAvailabilityFilter(cmds, store)` / `fuzzyFilterCommands(cmds, q)` / `groupCommandsByCategory(cmds): CommandGroup[]`.
- `store.paletteRequest: PaletteRequest | undefined`; `store.setPaletteRequest(Omit<PaletteRequest,'nonce'> | undefined)`.

## Env flags
- None.

## Gotchas
- `action` must NOT close over the store — invoked with fresh `useChatStore.getState()` at dispatch; `dispatch` calls `onClose()` BEFORE `action`.
- One owner per kind: owner clears slot via `setPaletteRequest(undefined)`; non-owners early-return and leave it. `NoteFloatingMenu` default branch returns WITHOUT clearing so `EditorToolbar` sees `open-score-info`.
- Single nonce-bumping bus slot (not per-kind) → back-to-back identical kinds still re-fire.
- `available` is snapshot ONCE per open (not reactive); selecting an event after open won't reveal selection-gated cmds until reopen.
- Span cmds need event `id` (`selectionHasEventWithId`), `open-tie` needs a pitched event (`selectionHasPitchedEvent`), not just a selection.
- `delete-measure` is the only catalog cmd that targets *measures* by mutating intent: its `action` calls `store.requestMeasureDelete(range)` (range = `measureRangeSelection` if set, else the selected event's bar), which opens the always-confirm `MeasureDeleteConfirmModal` rather than publishing a `PaletteRequest` or editing directly. The actual span/marker-safe `dragMeasureRange` delete fires only on confirm. Same gate backs the NoteFloatingMenu Structure-submenu 🗑 button.
- Cmd-K fires regardless of focus (capture + stopPropagation); rejects shift/alt (bare K = voltas popover).
- `paletteOpen` is local Hero state, not store.

## When editing X, also update Y
- New popover-opening command → add `{kind;nonce}` arm to `PaletteRequest` (state.ts) + catalog entry + `case` in the owning subscriber switch (NoteFloatingMenu or EditorToolbar). Set target snapshot BEFORE the open flag.
- New `kind` → ensure exactly one subscriber owns + clears it, else slot lingers.
- Change a category → edit the command's `hint` prefix (grouping is derived, no registry).
- Ranking change → edit `fuzzyTermScore`/`subsequenceScore`; keep tie-break-by-index stable sort.

## Related cards
chat-store-state, note-floating-menu, editor-toolbar, popover-shell, ghost-preview-proposal
