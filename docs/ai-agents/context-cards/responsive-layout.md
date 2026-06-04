---
title: responsive-layout — Context Card
subsystem: responsive-layout
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: 41db583
source_paths:
  - src/app/globals.css
  - src/app/layout.tsx
  - src/lib/ui/breakpoints.ts
  - src/lib/ui/useMatchMedia.ts
  - src/lib/ui/useViewportRect.ts
  - src/components/AppShell.module.css
  - src/components/HomeClient.tsx
  - src/components/AppHeader.tsx
  - src/components/ChatHistoryPanel.module.css
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
