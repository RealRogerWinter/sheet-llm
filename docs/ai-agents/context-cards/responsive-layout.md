---
title: responsive-layout — Context Card
subsystem: responsive-layout
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 68287d8
source_paths:
  - src/app/globals.css
  - src/app/layout.tsx
  - src/lib/ui/breakpoints.ts
  - src/lib/ui/useMatchMedia.ts
  - src/lib/ui/useViewportRect.ts
  - src/lib/ui/bottomSheet.ts
  - src/components/AppShell.module.css
  - src/components/HomeClient.tsx
  - src/components/AppHeader.tsx
  - src/components/AppHeader.module.css
  - src/components/MobileNav.tsx
  - src/components/MobileNav.module.css
  - src/components/SessionsButton.tsx
  - src/components/SessionsButton.module.css
  - src/lib/legal/useLegalEnabled.ts
  - src/components/ChatHistoryPanel.tsx
  - src/components/ChatHistoryPanel.module.css
  - src/components/ChatPanelFab.tsx
  - src/components/ChatPanelFab.module.css
  - src/components/orchestrator/GhostPreviewPanel.module.css
  - src/components/editor/useLongPress.ts
  - src/components/editor/touchGestureBus.ts
  - src/components/editor/usePinchZoom.ts
  - src/components/editor/useStaffInteractions.ts
related:
  - app-shell
  - editor-ui
---

# Responsive layout

The app is responsive from **320px phones to 4K desktops with full touch
editing**. Built as a default-on overhaul (no feature flag).

## Design tokens (`src/app/globals.css` `:root`)

- **Breakpoints** mirror `src/lib/ui/breakpoints.ts` (`xs 360, sm 480, md 768,
  lg 1024, xl 1280, xxl 1536`). CSS `@media` literals MUST match the JS, since
  CSS can't read custom props. Consume via `mq.up/down/between` +
  `useMatchMedia` (the canonical reactive matchMedia hook).
- **Fluid type** `--text-xs..2xl` (`clamp()`, floors = pre-overhaul px). Adopt
  per component only where the floor matches today's value.
- **Fluid space** `--space-2xs..xl` extends the fixed `--gap-1..8`.
- **Sizing** `--app-header-height` (published live by AppHeader's ResizeObserver,
  not hardcoded), `--sidebar-w`, `--panel-w`, `--score-max`, etc.
- **z-index** `--z-*` semantic scale; **safe-area** `--safe-*`; `--touch-target: 44px`.
- The Next 16 `viewport` export (layout.tsx) sets `viewportFit: 'cover'`
  (enables safe-area insets) + light/dark `themeColor`; user-scaling stays on.

## App-shell grid (`AppShell.module.css` + `HomeClient.tsx`)

CSS Grid: `grid-template-columns: minmax(0,1fr) auto` (main | panel),
`grid-template-rows: auto 1fr` (header | body). `minmax(0,1fr)` is load-bearing
— a bare `1fr` floors at min-content and overflows. In-flow members place via
`grid-area` on their own class (AppHeader→header sticky, Hero→main). The session
**sidebar stays a fixed overlay** (keeps its drawer animation), NOT a grid
column. The transport bar can't be a grid row (fixed, abc-gated, deep in
ScoreStage); it reads `--sidebar-offset` / `--panel-offset` (published by
SessionSidebar / HomeClient) to clear the docked chrome.

**Docked side panels PUSH/REFLOW the score** (≥1280px): ChatHistoryPanel docked
+ GhostPreviewPanel become sticky items in the `panel` grid track, so the score
reflows beside them instead of being overlaid. Only one occupies the track at a
time (ChatHistoryPanel yields when `pendingProposal.presentation==='diff-panel'`).
Drawer/sheet modes stay fixed overlays.

## Header consolidation below `lg` (`MobileNav`, SHE-10)

The `AppHeader` toolbar (`SessionsButton`, `Wordmark`, then `ImportScoreButton`,
`NewMenu`, `UsageCounter`, `HelpButton`, `PricingNavButton`, `ThemeToggle`,
`AuthNavButton`, `HeaderMenu`) wrapped to 2–3 rows on phones. Below **`lg`
(1024px)** it now collapses to one compact row — `Sessions` (icon-only) ·
`Wordmark` · `UsageCounter` · a single **`MobileNav`** "⋮" button — and every
secondary control folds into that one portaled dropdown.

- **Split is pure CSS**, not JS `matchMedia`: `AppHeader.module.css` wraps the
  desktop-only and mobile-only subtrees in `.desktopOnly` / `.mobileOnly`, both
  `display: contents` so the **desktop toolbar lays out byte-for-byte as before**
  (the wrappers add no box), toggled to `display: none` at the `1023.98/1024`
  mirror of `BREAKPOINTS.lg`. CSS `@media` applies pre-first-paint, so there is
  **no hydration flash** and the `ResizeObserver` → `--app-header-height` measures
  only the visible layout (a `display:none` subtree contributes 0 to `offsetHeight`).
- **`lg`, not `md`**, on purpose: `SessionsButton` and `SessionSidebar` already
  switch drawer↔dock at 1024, so one breakpoint governs the whole left-nav+header.
- **`MobileNav` is a dropdown, not a sheet** (`role="menu"`, `--z-popover` 110 —
  above panels, below modals). A sheet would over-serve nav and collide with the
  SHE-11 chat sheet's body-scroll-lock. Each item **mirrors its desktop control's
  gate reading the SAME store** (New's confirm + `!hasContent`/`pending` disables,
  Import's `pending`, Auth's loading/disabled/anon/authed, legal `/api/legal`
  gate) and **closes the menu before acting**; it owns its own `ImportModal` /
  `HelpModal`. Roving focus (↑/↓/Home/End), 44px targets, focus-visible outlines,
  focus restored to the trigger on close.
- **Single-instance stateful pieces**: `UsageCounter` renders once in the
  always-visible slot (no double `/api/usage`); the legal gate is a
  module-memoized `useLegalEnabled()` shared by `HeaderMenu` + `MobileNav` (one
  `/api/legal`). `ImportModal`/`HelpModal` moved from `--z-overlay`(50) to
  `--z-modal`(1000) so they sit above the chat panel when launched from the menu.

## Opening the conversation on touch (`ChatPanelFab` + sheet drag, SHE-11)

Below the dock breakpoint the panel is a toggled overlay, so it needs an
on-screen, pointer-activatable open control (the header `ChatHistoryButton` was
removed in PR #65, leaving only keyboard toggles: Ctrl/⌘+/ and the ⌘K palette,
both still wired). **`ChatPanelFab`** is a bottom-right floating action button
that calls `togglePanel()` with the same a11y semantics the old button had
(`aria-controls="chat-history-panel"`, `aria-expanded`, `aria-keyshortcuts`,
turn-count label). It self-gates: hidden in docked mode, when there's no
conversation (`!abc || turns.length===0`, mirroring the panel's own render gate),
and while the panel is already open. It sits above the fixed transport
(`--transport-height`) + safe-area inset.

**Sheet-mode drag-to-dismiss** (`<768px`): the grabber is a real
pointer-activatable handle (not the old decorative `::before`). The drag→snap
DECISION is the pure, exhaustively-tested `src/lib/ui/bottomSheet.ts`
(`resolveSheetDrag`/`clampDragOffset`): a small drag snaps back open; a drag past
`POSITION_THRESHOLD_RATIO` of the sheet height OR a flick past
`VELOCITY_THRESHOLD_PX_PER_MS` commits (state machine collapsed↔expanded↔
dismissed). `ChatHistoryPanel`'s `useSheetDrag` feeds live pointer geometry in and
applies the result (close on `dismissed`). Body scroll is locked while the sheet
is expanded; `prefers-reduced-motion` skips the live transform + snap transition
(instant state change). The grabber also accepts a plain tap to close. Drawer
mode (768–1280px) is unchanged (right-edge overlay).

**GOTCHA:** never put `container-type` on Hero (or any ancestor of the editor
overlays) — it applies layout containment and becomes the containing block for
the fixed/absolute overlays (NoteFloatingMenu, ContextMenu, modals), mis-anchoring
them and shrinking `inset:0` backdrops. The toolbar can't host one either (its
SubMenu popovers are inline fixed DOM descendants).

## Touch editing (`src/components/editor/`)

All score input is pointer-based. `touch-action: pan-y` on the score scroll
wrapper (1-finger scroll) + `touch-action: none` on note/rest glyphs (own
drag/pitch gestures).

- **Tap-to-place / select** — `useStaffInteractions` (pointer events + tap-vs-drag
  guard + `isPrimary`).
- **Long-press** — `useLongPress` (touch/pen only) opens the context menu on iOS
  (no native `contextmenu`) and arms touch measure-range select (long-press a
  bar → tap bars to extend). Android double-fire deduped via `touchGestureBus`.
- **Pinch-zoom** — `usePinchZoom` maps two-pointer distance onto the `ZOOM_LEVELS`
  ladder; sets `touchGestureBus.pinchActive` so `useNoteDrag` aborts an in-flight
  drag.
- `touchGestureBus` is the module-level coordinator for these cross-hook flags.

## Testing

Unit: `tests/unit/lib/ui/*` (hooks) + `tests/unit/components/editor/*` (pointer/
long-press/pinch). Real-browser: `tests/e2e/responsive-layout.spec.ts` (viewport
ladder, no-overflow + push-no-overlap + overlay-containment guard) and
`touch-editing.spec.ts` (tap-to-select + touch-action routing). E2e is
non-blocking (not in the CircleCI gate). `tests/setup.ts` provides the
matchMedia + pointer + getBBox jsdom stubs.
