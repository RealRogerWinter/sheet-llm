---
title: Chat & Session State (client) — context card
subsystem: chat-session
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/chat/state.ts
  - src/lib/chat/useSubmitPrompt.ts
  - src/lib/chat/useTranscriptSync.ts
  - src/lib/chat/useEditPersistence.ts
  - src/lib/chat/persistenceQueue.ts
  - src/lib/chat/usePromptPhase.ts
  - src/lib/chat/usePromptHistory.ts
  - src/components/SessionSidebar.tsx
  - src/components/orchestrator/ResumeProposalToast.tsx
related:
  - orchestrator
  - score-model
  - session-persistence
  - ghost-preview
---

# chat-session — context card

Client zustand store + hooks owning one editor session: chat transcript,
request lifecycle, rendered ABC/`editedScore`, undo history, AI
proposal/confirm gates, prompt phase, and edit persistence.

## Files
- `src/lib/chat/state.ts` — `useChatStore`, the `ChatStore` shape, all mutators, undo/redo+coalesce, pruners, proposal slots, `streamScoreSection` (progressive section render for score-stream responses). START HERE.
- `src/lib/chat/useSubmitPrompt.ts` — `submit()`; request body + optimistic appends + response branching + `consumeConverseStream` SSE parser + `consumeScoreStream` (selected when response carries `X-Stream-Kind: score`).
- `src/lib/chat/useTranscriptSync.ts` — GET hydration of turns+head score on refresh/switch.
- `src/lib/chat/useEditPersistence.ts` — `editedScore` → queue; beacon listeners; wires adapter to live head.
- `src/lib/chat/persistenceQueue.ts` — module-singleton batch/coalesce/retry/beacon; CAS head chain.
- `src/lib/chat/usePromptPhase.ts` — `PromptPhase` for Send button.
- `src/lib/chat/usePromptHistory.ts` — ArrowUp/Down prompt recall.
- `src/components/SessionSidebar.tsx` — session switch (clearTurns→setChatId).
- `src/components/orchestrator/ResumeProposalToast.tsx` — 30s resume of interrupted proposal.

## Key types / exports (from state.ts unless noted)
- `useChatStore` (the store); types `BaseDuration`, `ActiveAccidental`, `Selection`, `MeasureRangeSelection`, `MeasureDragState`, `PaletteRequest`, `PendingProposal`, `PendingProposalPresentation`, `ContextMenuState` (M27), `ClipboardEntry` (M28). (`TargetRegion` is imported from `@/lib/shared/types`.)
- Newer interaction slots + mutators: `pendingMeasureDelete` + `requestMeasureDelete`/`confirmMeasureDelete`/`cancelMeasureDelete`; `contextMenu` + `openContextMenu`/`closeContextMenu` (M27); `clipboard` + `setClipboard`/`clearClipboard` (M28); `aiSeed` + `seedAiInput(text, targetRegion?)` (M29 — pre-fills+focuses PromptBar without sending; D5 carries a `targetRegion`).
- Mount hooks: `useChatIdSession`, `useFollowPlaybackSync`, `useReduceMotionSync`.
- Helpers: `effectiveActiveDuration`, `computeProposalPresentation`, `GHOST_PREVIEW_INLINE_THRESHOLD` (=4).
- `useSubmitPrompt() → {submit,pending,error}` (`submit(text, {targetRegion?})`); effect hooks `useTranscriptSync`/`useEditPersistence`/`useChatHistoryShortcut`; `usePromptPhase() → PromptPhase`; `usePromptHistory() → {previous,next,reset}`; `resetSession(chatId)`.
- queue: `enqueue`, `flushSync`, `flushBeacon`, `setAdapter`, `getPendingCount`, `subscribeToPending`, `__resetForTesting`.
- `ResumeProposalToast`, `RESUME_TOAST_TIMEOUT_MS` (30_000).

## Env flags
- `SL_GHOST_PREVIEW` — default ON (since M24-PR-6). Server-side; gates proposal-mode responses. Client just reacts to `data.proposal`.
- `NEXT_PUBLIC_BALANCED_EDITS` — default on; `=off` makes `applyBalancedEdit` a silent no-op (NOT a fallback).
- `NODE_ENV` — when `!== 'production'`, `applyBalancedEdit`/`applyScore` run a `validateScore()` assertion that throws.

## Gotchas
- `editedScore === scoreJson` is REFERENCE equality = "no manual edit"; gates persistence + `hasEdits`. `applyRevertResponse` reuses the same ref to suppress a phantom POST. A needless clone breaks the gate.
- `markChatActive(false)` must run on EVERY terminal path (resolve/endNoScore/fail) or `clientBackup`'s recovery-reload stays suppressed.
- Replacement gate is checked BEFORE proposal gate; mutually exclusive. New submits clobber an existing `pendingProposal` with no guard.
- `useTranscriptSync` skips when turns+score present → SessionSidebar must `clearTurns()` before `setChatId()`.
- `persistenceQueue` is a global singleton; `__resetForTesting` between tests; adapter `getHead` reads live store to avoid stale-parent 409s.
- `applyEdit` does NO validation (invalid measures allowed for LLM repair).
- Whole-measure deletion uses an always-confirm gate: `requestMeasureDelete(range)` stages `pendingMeasureDelete` (refusing to delete every bar), `confirmMeasureDelete` fires a `dragMeasureRange` delete via `applyEdit` (the span/marker-safe op — NOT legacy `deleteMeasure`), `cancelMeasureDelete` clears it. Renderer is `MeasureDeleteConfirmModal` (editor-ui card).
- Rejected/timed-out proposals leave orphan candidate rows server-side BY DESIGN; accept/reject network call is the component's job, not the mutator's.
- Every failure leaves a PERMANENT errored turn in the transcript (#259), not just the transient `error` chip: `failStreamingTurn(idx,msg)` flips an in-flight placeholder to `errored:true` (keeping partial text); every other failure path calls `appendErrorTurn(msg)`. Both also `failRequest(msg)`. `appendErrorTurn` turns are client-only (synthetic `toolUseId`) → replaced by a transcript re-sync.
- `PromptPhase 'sending'` is in the union but never emitted at runtime.

## When editing X, also update Y
- New `ChatStore` field → add init value + setter; decide preserve-vs-reset in each score-swapping mutator.
- New score-swapping mutator → call `renderWithMap`, push/coalesce history, run BOTH pruners, clear `measureDragState`, stash any `pendingProposal` → `interruptedProposal`. (Template: `applyScore`.)
- New `/api/chat` response branch → edit `useSubmitPrompt.submit` JSON section; mind ordering vs replacement/proposal gates (terminal, no `resolveRequest`).
- Change `GHOST_PREVIEW_INLINE_THRESHOLD` → re-check inline overlay (PR-3) + docked diff panel (PR-4) layout.
- Change persistence batch shape → keep `useEditPersistence` enqueue + `persistenceQueue` POST body in sync; `/api/sessions/:id/versions/batch` server contract.

## Related cards
orchestrator · score-model · session-persistence · ghost-preview · command-palette · abc-render
</content>
