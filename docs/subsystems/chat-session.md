---
title: Chat & Session State (client)
subsystem: chat-session
audience: [contributor, ai-agent]
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
  - src/lib/chat/useChatHistoryShortcut.ts
  - src/lib/chat/resetSession.ts
  - src/components/PromptBar.tsx
  - src/components/ChatHistoryPanel.tsx
  - src/components/SessionSidebar.tsx
  - src/components/orchestrator/ResumeProposalToast.tsx
related:
  - orchestrator
  - score-model
  - abc-render
  - session-persistence
  - command-palette
  - ghost-preview
---

# Chat & Session State (client)

The client-side zustand store (`src/lib/chat/state.ts:useChatStore`) and the
React hooks around it own everything about a single live notation-editor
session in the browser: the chat transcript, the in-flight request lifecycle,
the rendered ABC + `editedScore`, the undo/redo history, the AI
proposal/confirmation gates, the prompt-bar phase machine, and the
debounced-then-beaconed edit-persistence pipe. It is the seam between the
user's keystrokes/edits and the server (`/api/chat`,
`/api/sessions/:id/versions/batch`, `/api/chat/revert`). The store is a
single flat object; almost every editor surface subscribes to a slice of it.

## Entry points

Read these in order:

1. `src/lib/chat/state.ts` — start with the `ChatStore` interface (the
   canonical shape of all state + mutators), then the mutator
   implementations below it. This file is the spine.
2. `src/lib/chat/useSubmitPrompt.ts` — `useSubmitPrompt().submit` is the one
   action callers invoke; the entire request/response branching
   (streaming / replacement-gate / proposal-gate / plain) lives here.
3. `src/lib/chat/useTranscriptSync.ts` — hydration on page refresh /
   session-switch.
4. `src/lib/chat/persistenceQueue.ts` + `src/lib/chat/useEditPersistence.ts`
   — the edit-write path (the only thing that POSTs manual edits).

## Key files

| Path | Role |
| --- | --- |
| `src/lib/chat/state.ts` | The zustand store (`useChatStore`), the `ChatStore` shape, every mutator, undo/redo + coalesce, selection pruning, the proposal/confirmation/interrupted slots, the mount-sync hooks (`useChatIdSession`, `useFollowPlaybackSync`, `useReduceMotionSync`), and `streamScoreSection` (progressive section render for score-stream responses). |
| `src/lib/chat/useSubmitPrompt.ts` | `submit()` — body construction, optimistic transcript appends, `flushSync` before POST, response branching, the hand-rolled SSE parser `consumeConverseStream` (converse text), and `consumeScoreStream` (score-stream responses, selected when `X-Stream-Kind: score`). |
| `src/lib/chat/useTranscriptSync.ts` | GET `/api/chat?chatId=…` hydration of turns + head score on refresh/switch, with 404/410 reset and a retry-nonce. |
| `src/lib/chat/useEditPersistence.ts` | Bridges `editedScore` changes into `persistenceQueue`, wires the queue adapter to the live store head, installs `visibilitychange`/`beforeunload` beacon listeners. |
| `src/lib/chat/persistenceQueue.ts` | React-free module-singleton batching/coalescing/retry/beacon queue; CAS head chaining; `__resetForTesting`. |
| `src/lib/chat/usePromptPhase.ts` | Derives `PromptPhase` from `pending`/`revealStartedAt`/`revealEpoch` for the animated Send button. |
| `src/lib/chat/usePromptHistory.ts` | ArrowUp/Down shell-style recall over user turns via ref cursor + draft stash. |
| `src/lib/chat/useChatHistoryShortcut.ts` | Document-level Ctrl/Cmd+/ toggle + Escape-close for the chat panel. |
| `src/lib/chat/resetSession.ts` | Best-effort server-side conversation DELETE (local clear already happened). |
| `src/components/PromptBar.tsx` | Primary prompt input; consumes `submit`/`usePromptPhase`/`usePromptHistory`. Also subscribes to the `aiSeed` bus (M29): an "Edit with AI" context-menu item calls `seedAiInput(text, targetRegion?)` to pre-fill + focus the input WITHOUT sending (gated by an AI flag). |
| `src/components/ChatHistoryPanel.tsx` | Ctrl+/ transcript panel; a second `submit` input (`PanelFooter`) + `RevertLink` (POST `/api/chat/revert` → `applyRevertResponse`). Responsive `usePanelMode` → `docked` (≥1280px) / `drawer` / `sheet`. **In the editor (a score is loaded) the panel is a PERMANENT docked sidebar — it ignores `panelOpen` and drops the close button. It overlays the right edge of the viewport; the score area (`Hero.module.css` `.scoreArea`) stays centered in the full window rather than reserving room for the panel.** It renders nothing when there is no score (the hero/landing state). The narrow `drawer`/`sheet` modes stay opt-in overlays that respect `panelOpen` + the Ctrl+/ toggle. Turns are speaker-coded: user messages hug the right (blue `--select` bubble, `--select-ink` accent), Claude's answers/scores hug the left (neutral card); `errored` text turns render as a red failure bubble. |
| `src/components/SessionSidebar.tsx` | Session list; drives chatId switches via `clearTurns()` then `setChatId()`; owns sidebar open/collapsed flags. |
| `src/components/orchestrator/ResumeProposalToast.tsx` | 30s resume window for an interrupted AI proposal (`RESUME_TOAST_TIMEOUT_MS`). |

## Core concepts / data flow

### The three score fields

| Field | Meaning |
| --- | --- |
| `scoreJson` | The LLM/hydration **baseline**. Reset to a fresh score on every `resolveRequest` / `seedHistoryFromServer` / `resolveImport` / accept. `resetEditsToLLM` walks back to it. |
| `editedScore` | The **current** score the editor renders. Diverges from `scoreJson` on the first manual edit. |
| `abc` + `editMap` | The rendered ABC string + `SourceMap`, recomputed via `scoreToAbcWithMap` (`renderWithMap`) on every score swap. |

The reference-equality test `editedScore === scoreJson` is the single
"has the user manually edited?" predicate. It gates edit persistence
(`useEditPersistence`) and `hasEdits` (`useSubmitPrompt`, computed as
`scoreJson !== undefined && historyPointer > 0`). Mutators that swap in a new
score set `editedScore` to a fresh reference; LLM/hydration responses set
both fields to the **same** reference so no phantom edit POST fires.

### Submit path

```
PromptBar / PanelFooter
  └─ useSubmitPrompt.submit(text, {targetRegion?})   (region from an aiSeed)
       ├─ guard: empty || pending → {ok:false}
       ├─ hasEdits = scoreJson!==undefined && historyPointer>0
       ├─ appendTurns([optimistic user turn])       (paints before fetch)
       ├─ beginRequest(text)  → markChatActive(true), pending=true
       ├─ flushSync(2000)     (drain edit queue so server transcript is current)
       └─ POST /api/chat {chatId, message, editedScore?, debug?, targetRegion?}
            ├─ 410 chat_full      → failRequest(...)                (keep chatId)
            ├─ 410 (other)        → failRequest(..., {resetChatId})  (drop chatId)
            ├─ !ok                → adopt data.chatId, failRequest
            ├─ X-Stream-Kind:score → consumeScoreStream(...)         (sectional score stream; calls streamScoreSection per section)
            ├─ content-type SSE   → consumeConverseStream(...)       (text, no score)
            └─ JSON ChatResponse:
                 ├─ requiresConfirmation && replacement → setPendingConfirmation (gate)
                 ├─ requiresConfirmation && proposal     → setPendingProposal     (gate)
                 └─ else → resolveRequest(abc, scoreJson, introText)
                           + setCurrentHeadVersionId(headVersionId)
                           + appendTurns([assistant render_score])
```

Replacement and proposal are **mutually exclusive** and **replacement is
checked first**; the server's `maybeAttachGhostProposal` returns early when
`result.replacement` is set, so both should never be populated. Neither gate
swaps the editor — `editedScore`/`scoreJson` stay on the prior score and the
relevant UI (ReplacementConfirmModal / inline overlay / docked diff panel)
renders a preview. The accept/reject network round-trip is the **component's**
job, not the store mutator's.

### Hydrate path (`useTranscriptSync`)

Fires only when there is a `chatId` AND (`turns` empty OR no `scoreJson`).
That guard is why **`SessionSidebar.handleSelect` must `clearTurns()` before
`setChatId()`** — otherwise the optimistic-append turns suppress the re-fetch.
GET `/api/chat?chatId=…`:

- 404/410 → `setChatId(undefined)` + `clearTurns()` (server-evicted id).
- ok → `setTurns(data.turns)`; if `data.versions` present, the whole parent
  chain is seeded via `seedHistoryFromServer` (so Ctrl+Z survives reload),
  else a single `resolveRequest`. Always `setCurrentHeadVersionId` (even with
  no score, so the first edit POST has a parent).
- network error → preserve chatId, set `transcriptError`; `retryTranscriptSync`
  bumps `transcriptRetryNonce` to refire the effect.

### Edit-write path

```
mutator (applyEdit / applyBalancedEdit / applyScore / undo / redo)
  → editedScore = next (new ref) + re-render abc + push history (coalesced)
       │
useEditPersistence effect (watches editedScore)
  ├─ skip if !chatId || !editedScore
  ├─ skip if editedScore === scoreJson         (baseline gate)
  ├─ skip if lastEnqueuedRef === editedScore    (dup re-render guard)
  └─ enqueue({chatId, score, source:'edit', coalesceKey:'edit'})
       │
persistenceQueue (module singleton)
  ├─ coalesce: replace tail job in place when chatId+coalesceKey match
  ├─ scheduleIdleFlush (2000ms) → flushOne
  ├─ flushOne: batch the leading run of same-chatId jobs → POST
  │     /api/sessions/:id/versions/batch {baseParentVersionId: adapter.getHead(), versions[]}
  │     ├─ 409 stale_parent → rewrite base to body.currentHead, retry ONCE
  │     ├─ 409 other        → re-enqueue front, bail (flushSync retries later)
  │     ├─ 5xx              → backoff [1s,2s,4s], up to MAX_ATTEMPTS=4
  │     └─ ok               → adapter.setHead(last versionId)
  └─ flushBeacon (on visibilitychange:hidden / beforeunload)
        navigator.sendBeacon(blob) → fallback fetch({keepalive:true})
```

The queue adapter's `getHead` reads the **live** store
(`useChatStore.getState().currentHeadVersionId`), not a render snapshot, so
`baseParentVersionId` never lags behind the last successful write.

### Undo history, coalesce, cap

`history: Score[]` + `historyPointer` form a standard undo stack.
`HISTORY_CAP = 50` (shift the oldest when exceeded); `COALESCE_WINDOW_MS =
500` collapses same-`coalesceKey` edits (e.g. holding a transpose key) into a
single entry when the pointer is at the tail. LLM/import/accept responses
**reset** history to a single checkpoint `[score]` at pointer 0 (every AI
turn is one undo step). `seedHistoryFromServer` seeds the whole persisted
chain so Ctrl+Z reaches pre-reload edits.

### epoch vs reveal fields

| Field | Bumps when | Consumer |
| --- | --- | --- |
| `epoch` | a score-**replacing** response lands (`resolveRequest` w/ score, `seedHistoryFromServer`, `resolveImport`, `applyRevertResponse`, `acceptPendingProposal`). NOT on `applyEdit`/`undo`/`redo`. | `ScoreStage` — gates the crossfade so edit-driven `abc` changes don't fade. |
| `revealStartedAt` / `revealEpoch` | reveal hook calls `markRevealStarted` / `markRevealComplete` after the network settles. | `usePromptPhase`. |

### PromptPhase machine (`usePromptPhase`)

```
pending=true                 → 'composing'
revealStartedAt !== null     → 'arriving'
donePulse (80ms after        → 'done'
  revealEpoch changes)
else                         → 'idle'
```

`PromptPhase` is `'idle' | 'sending' | 'composing' | 'arriving' | 'done'`, but
`'sending'` is **never emitted at runtime** — it exists in the union and the
`PromptBar` switch handles it, but `usePromptPhase` returns one of the other
four. `DONE_HOLD_MS = 80`.

### Proposal / confirmation / interrupted slots

| Slot | Set by | Shape | Notes |
| --- | --- | --- | --- |
| `pendingConfirmation` | replacement gate (M3.5) | inline object w/ `retainedIdentityRatio`, `reasons` | wholesale-rewrite gate; ReplacementConfirmModal. |
| `pendingProposal` | proposal gate (M24, `SL_GHOST_PREVIEW`) | `PendingProposal` | fires for **every** AI edit; `presentation` auto-derived. |
| `interruptedProposal` | manual mutators when a `pendingProposal` exists | same `PendingProposal` | `ResumeProposalToast` offers a 30s resume reusing the same `candidateVersionId`. |

`setPendingProposal` auto-computes `presentation` via
`computeProposalPresentation(affectedEventIds)` — `<= GHOST_PREVIEW_INLINE_THRESHOLD`
(=4) → `'inline'`, else `'diff-panel'`. `acceptPendingProposal` swaps
`editedScore`/`scoreJson` to `candidateScore`, writes the pre-rendered
`abc`, resets history to `[candidateScore]`, bumps `epoch`, clears the slot.
`rejectPendingProposal` only clears the slot. **Every manual mutator**
(`applyEdit`, `applyBalancedEdit`, `applyScore`, `undo`, `redo`,
`resetEditsToLLM`, `resolveImport`) stashes a live `pendingProposal` onto
`interruptedProposal` first.

### Selection pruning

Two pruners run on **every** score swap so downstream consumers never
dereference a stale index:

- `pruneSelection` (voice-aware: checks staff/voice/measure/event/pitch via
  `scoreAccessors`; on a stale-only pitch it keeps the event but drops
  `pitchIdx`).
- `pruneMeasureRangeSelection` (clamps `fromStart`/`fromEnd` to
  `measures.length-1`; drops the range if it collapses or the score is empty).

### Other interaction slots (UI buses on the same store)

The flat store also carries several non-transcript interaction slots that newer
editor surfaces subscribe to:

| Slot | Set by | Notes |
| --- | --- | --- |
| `pendingMeasureDelete` (`MeasureRangeSelection`) | `requestMeasureDelete(range)` (floating menu / Delete key / ⌘K) | Always-confirm gate; refuses to stage deletion of *every* bar. `confirmMeasureDelete` clears the slot then fires a `dragMeasureRange` `mode:'delete'` op through `applyEdit` (the span/marker-safe path — NOT legacy `deleteMeasure`). `cancelMeasureDelete` clears it. Renderer: `MeasureDeleteConfirmModal`. |
| `contextMenu` (`ContextMenuState`) | `openContextMenu` (M27, from `useScoreContextMenu`) | Right-click / ContextMenu-key / long-press hit-test result; consumed by the `ContextMenu` component. `closeContextMenu` clears. |
| `clipboard` (`ClipboardEntry`) | `setClipboard` (M28, copy serializers in `src/lib/chat/clipboard.ts`) | In-app copy/cut payload (structural `Event[]` fragment, spans carried); `undefined` when empty. `clearClipboard` resets. |
| `aiSeed` (`{text, nonce, targetRegion?}`) | `seedAiInput(text, targetRegion?)` (M29) | Pre-fills + focuses the PromptBar without sending; `nonce` auto-increments so repeated identical seeds re-fire the subscriber. `targetRegion` (D5) scopes the request to a measure region threaded to the dispatcher. |

## Invariants & gotchas

- **`editedScore === scoreJson` is reference (not deep) equality.** The gate
  breaks if a mutator clones an otherwise-identical score.
  `applyRevertResponse` deliberately sets both fields to the **same**
  reference to suppress a phantom POST of the reverted score.
- **`markChatActive` must be cleared on every terminal path.** It's set in
  `beginRequest` and cleared in `resolveRequest`, `endRequestNoScore`,
  `failRequest`. It mirrors a `globalThis.__sheetLlmChatActive` flag that
  `src/lib/auth/clientBackup.ts` reads to avoid a recovery `location.reload()`
  while destructible chat state is in memory. Miss a terminal path → the
  reload stays suppressed forever.
- **New submits clobber an existing `pendingProposal` with no guard.** The
  proposal branch in `submit` overwrites the slot; submitting a new prompt
  implicitly abandons the prior proposal. Manual-edit interruption is the
  separate `interruptedProposal` path.
- **`SessionSidebar` must `clearTurns()` before `setChatId()` on switch**
  (and on delete-of-active), or `useTranscriptSync`'s "already has turns →
  skip" guard suppresses the re-fetch. This is wired correctly today; preserve
  it.
- **`persistenceQueue` is a global module singleton.** Reset it with
  `__resetForTesting` between tests. The adapter's `getHead` reads the live
  store so the chain doesn't 409 on a stale parent.
- **`applyEdit` does NO validation** — invalid measures are allowed on purpose
  (the LLM repairs them on the next prompt; only `transformScore`'s hard
  impossibilities throw `EditError`). `applyBalancedEdit` and `applyScore`
  add a **dev-only** `validateScore()` assertion (`NODE_ENV !== 'production'`)
  that throws to pin the corrupt call site early.
- **`NEXT_PUBLIC_BALANCED_EDITS=off` makes `applyBalancedEdit` a silent no-op**
  — not a fallback to `applyEdit`. It returns before doing anything; the
  caller decides whether to fall back.
- **Rejected/dismissed/timed-out proposals leave orphan candidate rows
  server-side by design.** The store mutators never call the network; the
  accept/reject/confirm-proposal POST is the component's responsibility.
- **`consumeConverseStream` and `consumeScoreStream` are both hand-rolled SSE
  parsers** (EventSource can't POST). `consumeConverseStream` handles text
  turns; `consumeScoreStream` handles `X-Stream-Kind: score` responses,
  calling `streamScoreSection` for each `section` frame and resolving on the
  `done` frame.
- **Every failure leaves a PERMANENT errored turn in the transcript** — not
  just the transient `error` chip/toast, which `beginRequest` wipes on the
  next submit. Two mechanisms, both rendering through the same errored-bubble
  path:
  - When a converse stream has an in-flight placeholder turn (header arrived),
    its `error`/throw/silent-drop paths call `failStreamingTurn(index, message)`
    — flipping that turn to `errored: true` with a human `errorText` and
    keeping any partial text already streamed.
  - Every other failure path — HTTP `!ok`, 410 `chat_full`, network throw,
    score-stream `error`/drop, and converse failures before the header — calls
    `appendErrorTurn(message)`, which pushes a standalone `errored` assistant
    text turn. (The 410 `chat_not_found` reset path is the one exception: it
    clears `abc`, hiding the panel, so it relies on the toast alone.)

  Both also call `failRequest(message)` (global toast + clears `pending`). The
  `appendErrorTurn` turns are client-only session artifacts (synthetic
  `toolUseId`, not server-persisted), so a transcript re-sync / refresh
  replaces them with the server's authoritative turns. The inline `requestError`
  chip remains as a fallback for `error`s set outside the submit flow (revert,
  measure-delete validation). `ChatHistoryPanel` renders an `errored` assistant
  turn as a red failure bubble (label "Generation failed"); server-hydrated
  turns that carry only an `errorCode` (no `errorText`) are mapped to a friendly
  sentence by `erroredTurnMessage`.
- **`PromptPhase 'sending'` is dead at runtime** (see above). Don't rely on it
  firing.

## How to extend / common tasks

- **Add a field to the store:** add it to the `ChatStore` interface, give it
  an initial value in the `create<ChatStore>` object, add a setter. If it's a
  score-adjacent field that must survive a score swap, decide whether each
  mutator should preserve or reset it (the mutators are explicit about every
  field they write).
- **Add a new chat-response branch:** edit the JSON section of
  `useSubmitPrompt.submit`. Decide ordering relative to the replacement and
  proposal gates (they're checked first and are terminal — they `return
  {ok:true}` without `resolveRequest`).
- **Add a new manual mutator that swaps the score:** call `renderWithMap`,
  push/coalesce into `history`, run **both** pruners, clear
  `measureDragState`, and (if it's a user action) stash any `pendingProposal`
  onto `interruptedProposal`. Copy `applyScore` as the template. Do NOT set
  `epoch` unless you want a crossfade.
- **Change the inline-vs-panel threshold:** edit
  `GHOST_PREVIEW_INLINE_THRESHOLD` in `state.ts` — it's the single source of
  truth; the inline overlay (PR-3) and docked panel (PR-4) layout assumptions
  key off it.
- **Tune persistence timing/retries:** `IDLE_FLUSH_MS`, `MAX_ATTEMPTS`,
  `BACKOFF_MS` in `persistenceQueue.ts`.

## Testing

| Test | Covers |
| --- | --- |
| `tests/unit/chat/state.test.ts` | core store: request lifecycle, resolve/fail/reset. |
| `tests/unit/chat/state.epoch.test.ts` | `epoch` bump semantics. |
| `tests/unit/chat/state.applyBalancedEdit.test.ts` | balanced edit + kill switch + validate assertion. |
| `tests/unit/chat/state.measureRangeSelection.test.ts` | range select/extend/prune. |
| `tests/unit/chat/state.pruneSelection.test.ts` | selection-pruning invariants. |
| `tests/unit/chat/state.transcript.test.ts` | turns append/stream/finalize. |
| `tests/unit/chat/pendingProposal.test.ts` | proposal slot + presentation derivation + accept/reject. |
| `tests/unit/chat/interruptedProposal.test.ts` | manual-edit-interrupts-proposal + resume. |
| `tests/unit/chat/persistenceQueue.test.ts` | coalesce, batch, 409 CAS retry, beacon. |
| `tests/integration/useSubmitPrompt.test.tsx` | submit branching: streaming/replacement/proposal/plain, 410 handling. |
| `tests/unit/usePromptPhase.test.ts` | phase state machine + done hold. |

The persistence-queue tests rely on `__resetForTesting`; the store tests
operate on the live singleton `useChatStore`, so reset relevant slices in
`beforeEach`.

## Related files / See also

- `src/lib/orchestrator/README.md` — the server side of `/api/chat`
  (dispatch, preservation verify, replacement gate, ghost-proposal attach).
- `src/lib/music/types.ts` — the `Score` schema every field here carries.
- `src/lib/music/editOperations.ts` (`transformScore`, `EditError`),
  `src/lib/music/transformScoreBalanced.ts`, `src/lib/music/measureBalance.ts`
  (`BalanceError`) — the edit transforms the mutators call.
- `src/lib/music/scoreToAbcWithMap.ts` — `renderWithMap`'s implementation.
- `src/lib/music/validateScore.ts` — the dev-only assertion source.
- `src/lib/auth/clientBackup.ts` — reads the `markChatActive` global flag.
- `src/lib/shared/types.ts` — `ChatRequest`, `ChatResponse`,
  `TranscriptResponse`, `TranscriptTurn`, `RevertRequest`/`RevertResponse`.
- `src/lib/chat/clipboard.ts` — copy/cut serializers that fill the `clipboard`
  slot (`ClipboardEntry`); `src/components/editor/contextTarget.ts` — the
  right-click hit-test feeding `ContextMenuState`.
</content>
</invoke>
