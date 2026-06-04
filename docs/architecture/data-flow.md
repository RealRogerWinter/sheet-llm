---
title: Request Lifecycle — Chat Edit, Import, Export
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/chat/useSubmitPrompt.ts
  - src/lib/chat/state.ts
  - src/app/api/chat/route.ts
  - src/lib/orchestrator/index.ts
  - src/app/api/chat/confirm-replacement/route.ts
  - src/lib/llm/conversations.ts
  - src/components/orchestrator/GhostPreviewOverlay.tsx
  - src/app/api/import/route.ts
  - src/components/ExportBar.tsx
related:
  - orchestrator
  - chat-session
  - ghost-preview
  - persistence-db
  - import
  - export
---

# Request Lifecycle

This is the end-to-end trace of a single chat-driven edit: a keystroke
in the prompt bar, through the orchestrator, into the versioned
score store, back out to the abcjs render, and finally through the
ghost-preview accept/reject gate that commits the new head. Import and
export are shorter side-flows that reuse the same persistence and render
machinery; they're covered at the end.

The orchestrator's internal stages (copyright → dispatch → handler →
preservation verify → replacement gate → ghost proposal) are described
in depth in [`../../src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md).
This doc is the *outer* loop — how a request enters and leaves that
machine, and what the client does on each side.

## 1. The chat-edit lifecycle (numbered)

1. **Keystroke → submit.** The user types into the prompt bar and hits
   send. `useSubmitPrompt.ts:submit` (`src/lib/chat/useSubmitPrompt.ts:60`)
   trims the message, computes `hasEdits = scoreJson !== undefined &&
   historyPointer > 0`, and finds the most-recent assistant
   `render_score` turn to anchor a refinement against its `toolUseId`. A
   right-click "AI" entry (M29) additionally puts a deterministic
   `targetRegion: { startMeasureIdx, endMeasureIdx }` on the body so the
   dispatcher can pin the edit to the clicked bars.

2. **Optimistic paint + drain.** It appends an optimistic user turn to
   the transcript and calls `beginRequest`, so the panel paints before
   the network resolves. It then `await`s `flushSync(2000)` on the
   edit-persistence queue (`src/lib/chat/persistenceQueue.ts`) so any
   in-flight manual-edit version writes land *before* the chat POST —
   otherwise the refinement would race the version chain and 409 on
   parent-CAS. Only when `hasEdits` is true is `editedScore` put on the
   request body.

3. **POST /api/chat.** `POST` in `src/app/api/chat/route.ts:314` runs
   same-origin + body-size checks (`MAX_BODY_BYTES = 1 MB`), parses
   against `ChatRequestSchema`, then resolves identity via
   `getRequestUser()` **before** touching the response (Next 16
   forbids `cookieStore.set` after flush) — a DB-backed `sl_sess`
   authenticates a claimed account, an `sl_uid` JWT authorizes an
   unclaimed anon (a stale `sl_uid` for a claimed account is refused).
   `handleChat` (`route.ts:357`) resolves/creates the chat, enforces the
   20-user-turn cap, schema-validates `editedScore`, runs the optional
   `score_version` freshness check (409 `stale_score` on mismatch), and
   resolves the paywall tier via `resolveGenerationTier(userId, ...)`
   (`free`/`pro`), threading the resolved value into the orchestrator.

4. **Persist the user turn first.** `await appendMessages(userId,
   chatId, [userTurn])` (`route.ts:445`) writes the user turn to the DB
   *before* the LLM call. This is the chat-vanish fix: if anything
   downstream throws, the prompt survives and re-collapses on retry via
   `prepareMessagesForLLM`.

5. **Resolve the orchestrator's score.** `orchestratorScore =
   validatedEdit ?? findLastAssistantScore(transcript)` (`route.ts:425`).
   The client only ships `editedScore` after a manual edit, so an
   unedited follow-up falls back to the last assistant-emitted score —
   without this the classifier sees `SCORE PRESENT: false` and refuses
   follow-ups.

6. **orchestrator.run.** Gated by `mode` (`primary` / `shadow` / `off`,
   from `ORCHESTRATOR_MODE` + debug override), the route calls
   `run(input)` (`src/lib/orchestrator/index.ts:634`). Internally:
   copyright filter → (when `SL_NEW_TOOL_DISPATCH` on **and**
   `editedScore` present) the 6-tool dispatcher (`extend_composition`,
   `insert_measures`, `region_replace`, `edit_intra_measure`,
   `regenerate_all`, and `answer_question` — the last routes to a
   `converse` stream and mutates nothing), else the legacy Haiku
   classifier → handler → `maybeApplyReplacementGate` →
   `maybeAttachGhostProposal` → `recordTurn`. Both gate hooks live in
   `finalizeDispatchResult` (`index.ts:581`) on the new path and inline
   at `index.ts:977` on the legacy path. On the `free` tier a
   `regenerate_all` decision is refused as Pro-only before any handler
   runs. See the orchestrator README for the gate predicates.

7. **Route handles the outcome.** In `primary` mode (`route.ts:537`):
   - `refused` → 422 `refused`.
   - converse stream → `respondWithConverseStream` (SSE).
   - `OrchestratorScoreStream` (M25: sectional generation) →
     `respondWithScoreStream` (SSE; emits `section` frames, then `done`
     or `error`; carries `X-Stream-Kind: score`; persists final score on
     `done`). `OutputTruncatedError` maps to 422 `output_too_large`.
   - `fellThrough` / `mode === 'off'` → the legacy single-shot Sonnet
     path (`completeWithRetry`, `route.ts:612`), **but two fall-through
     reasons short-circuit first** (M26 follow-up): a
     `deadline_exceeded` fall-through returns a clean 503 instead of
     running a second full generation, and on the `free` tier *any*
     fall-through returns a 422 `refused` ("couldn't apply as a quick
     edit… switch to Pro") rather than the slow/often-invalid regen.
     When the legacy path does run on free tier (only `mode === 'off'`),
     it is bounded to `BOUNDED_EMIT_CEILING` tokens + a single retry.
   - otherwise → `respondWithOrchestratorResult` (`route.ts:820`).

8. **Validate → ABC → persist → version row.**
   `respondWithOrchestratorResult` runs `validateScore`, transpiles
   `scoreToAbc`, re-validates the ABC via abcjs (`validateAbc`), then
   appends the synthetic assistant turn. The key branch:
   `gateFired = result.requiresConfirmation === true` (`route.ts:874`).
   `appendMessages(..., gateFired ? { skipHeadVersionBump: true } :
   undefined)` writes a `score_versions` row inside
   `tryInsertScoreVersionForAssistant`
   (`src/lib/llm/conversations.ts:455`) and **only advances
   `sessions.head_version_id` when the gate did NOT fire**
   (`conversations.ts:323`). When `requiresConfirmation` is set, the row
   is a *candidate* hanging off the prior head.

9. **Response shape.** The body carries `abc`, `scoreJson`, `toolUseId`,
   `headVersionId` (read back via `readHeadVersionId`, `route.ts:774`),
   and `debug` (which now includes the resolved `generationTier`). When
   the gate fired it additionally carries **either**
   `replacement: { retainedIdentityRatio, reasons, candidateVersionId }`
   **or** `proposal: { affectedEventIds, candidateVersionId }` — never
   both (the ghost hook returns early when `result.replacement` is set,
   `index.ts:168`).

10. **Client branch.** Back in `submit` (`useSubmitPrompt.ts:157`):
    - `X-Stream-Kind: score` (M25 sectional generation) →
      `consumeScoreStream` drains the SSE stream; each `section` frame
      calls `streamScoreSection` (`state.ts`) to progressively render the
      cumulative score without clearing pending state. The final `done`
      frame commits the complete score.
    - `requiresConfirmation && replacement` → `setPendingConfirmation`;
      the editor does **not** swap; `ReplacementConfirmModal` owns the
      decision.
    - `requiresConfirmation && proposal` → `setPendingProposal`; the
      editor does **not** swap head state; the ghost overlay/panel owns
      the decision. (Replacement is checked first; it wins if both
      somehow appear.)
    - otherwise → `resolveRequest(abc, scoreJson, introText)`
      (`src/lib/chat/state.ts:1095`) commits the score immediately
      (silent commit, e.g. `SL_GHOST_PREVIEW=0`).

11. **Score → ABC → abcjs render.** `resolveRequest` (and
    `acceptPendingProposal`) call `renderWithMap(score)`
    (`state.ts:832`), which produces the `abc` string **and** a
    `SourceMap` (`editMap`) linking Score events/pitches to ABC char
    ranges. The map is what lets a notehead click round-trip back to a
    Score selection. The store sets `history: [score]`,
    `historyPointer: 0`, and bumps `epoch` to drive a fresh abcjs render
    + reveal animation.

12. **Ghost accept/reject → head commit.** For a `proposal`, the editor
    already shows the candidate's abc (amber-recolored affected
    noteheads via `GhostPreviewOverlay`). Accept (Enter) / reject (Esc)
    both POST `/api/chat/confirm-replacement`
    (`GhostPreviewOverlay.tsx:67`). That route
    (`src/app/api/chat/confirm-replacement/route.ts:50`):
    - **accept** → advances `sessions.head_version_id` to the candidate
      row; the client calls `acceptPendingProposal` (swaps editor score,
      resets history, bumps epoch) + `setCurrentHeadVersionId` +
      appends a `render_score` transcript turn.
    - **reject** → writes a `revert` `score_versions` row pointing at the
      prior head (head re-asserts the pre-edit score, content-identical);
      the client calls `rejectPendingProposal` + advances its local head
      pointer so the next edit POST chains the right CAS link.

The head pointer is the single source of truth for "current score";
hydration on refresh (`GET /api/chat`, `extractHeadScore`,
`route.ts:1546`) prefers `score_versions[head_version_id]` over the
transcript scan so persisted manual edits survive.

## 2. ASCII swimlane

```
PromptBar /          /api/chat (route.ts)        orchestrator.run        DB (score_versions
GhostOverlay                                     (index.ts)              + sessions.head)
────────────         ───────────────────         ─────────────────       ──────────────────
submit() ───POST──▶  same-origin + size
                     parse + auth + caps
                     appendMessages([user]) ───────────────────────────▶ user msg row
                     run(input) ──────────────▶  copyright filter
                                                 dispatch (6-tool /
                                                 legacy classifier)
                                                 handler → Score
                                                 preservationVerifier
                                                 maybeApplyReplacementGate
                                                 maybeAttachGhostProposal
                                  ◀──────────────  result {score,
                                                   requiresConfirmation?,
                                                   replacement?|proposal?}
                     validateScore
                     scoreToAbc + validateAbc
                     appendMessages([assistant],
                       skipHeadVersionBump =
                       requiresConfirmation) ──────────────────────────▶ score_versions row
                                                                          (candidate if gated;
                                                                           else head bumps)
       ◀──JSON───── {abc, scoreJson, headVersionId,
                     replacement?|proposal?}
 branch:
  replacement → setPendingConfirmation (modal)
  proposal    → setPendingProposal (overlay/panel)
  else        → resolveRequest → renderWithMap → abcjs

 [proposal] Accept/Reject
  ──POST /api/chat/confirm-replacement─────────────────────────────────▶ accept: head ⇒ candidate
                                                                          reject: insert revert row,
                                                                                  head ⇒ revert
       ◀──{headVersionId}──
  acceptPendingProposal → renderWithMap (head committed)
  | rejectPendingProposal (score untouched)
```

## 3. The gate seam — `requiresConfirmation`

The replacement gate (M3.5) and the ghost preview (M24) share **one**
mechanism: a boolean `requiresConfirmation` on the orchestrator result
that makes the route pass `skipHeadVersionBump: true`. The difference is
purely which payload rides alongside and which client UI claims it.

| Field on result        | Set by                                  | Client slot              | Commits via                          |
| ---------------------- | --------------------------------------- | ------------------------ | ------------------------------------ |
| `replacement`          | `maybeApplyReplacementGate` (`index.ts:108`) | `setPendingConfirmation` | `/api/chat/confirm-replacement`      |
| `proposal`             | `maybeAttachGhostProposal` (`index.ts:162`)  | `setPendingProposal`     | `/api/chat/confirm-replacement`      |
| (neither)              | silent commit                           | `resolveRequest`         | head bumped inside `appendMessages`  |

**Invariant:** at most one of `replacement` / `proposal` is set per
turn. The ghost hook short-circuits when `result.replacement` is already
present (`index.ts:168`) and when `requiresConfirmation` is already true
(`index.ts:169`, the preview-mode `regenerate_all` case). Both client
branches honor the same order — replacement first
(`useSubmitPrompt.ts:195` then `:236`).

The ghost hook also calls `ensureEventIds(result.score)` on the candidate
before computing `affectedEventIds` (`index.ts:184`) — orchestrator
results don't carry event ids (they're backfilled only on the
migrate-on-load path), so without it `computeAffectedEventIds` returns
`[]` and the amber overlay highlights nothing.

**Gotcha:** the ghost overlay reuses the *replacement* confirm endpoint
because its accept/reject CAS semantics are identical. There is no
separate `/api/chat/confirm-proposal` route.

## 4. Import flow (brief)

Import never calls the LLM and is independent of the orchestrator.

1. `POST /api/import` (`src/app/api/import/route.ts:249`) accepts either
   `multipart/form-data` (binary MIDI / uploaded `.musicxml` files, cap
   `MAX_MULTIPART_BYTES = 2 MB`) or `application/json`
   (`{ format, text, filename? }` — ABC, Score JSON, or pasted MusicXML,
   cap `MAX_JSON_BYTES = 1 MB`).
2. `detectFormat` (`src/lib/music/import/detect.ts`) sniffs filename +
   MIME + content into `'abc'|'json'|'midi'|'musicxml'|'blank'` (a
   `.musicxml`/`.xml` extension or a `<score-partwise>`/`<score-timewise>`
   body resolves to `musicxml`). `unknown` and `xml-unsupported` (the
   latter now means a **compressed `.mxl`** container, which is out of
   scope) return 422 `import_failed`. `blank` skips the parser and seeds
   `BLANK_SCORE`.
3. `importScore` (`src/lib/music/import/index.ts`) parses to a Score
   (MusicXML via `musicxmlToScore` + `fast-xml-parser`) and applies
   shared normalization (anacrusis padding + length truncation).
4. `validateScore` (semantic) → `scoreToAbc` → `validateAbc` — the same
   post-LLM check the chat route runs. Any failure → 422.
5. `seedConversation` (`route.ts:204`) creates a fresh chat and writes a
   synthetic user prompt + assistant `tool_use` turn with a
   `synthToolUseId()` anchor and `{ scoreSource: 'import' }`. This lets
   subsequent `/api/chat` refinements anchor against the imported score
   exactly like an LLM-produced one. The `score_versions` row is sourced
   `'import'`.
6. Response mirrors a chat response (`abc`, `scoreJson`, `toolUseId`,
   `warnings`, `importFormat`); the client adopts the returned `chatId`.

## 5. Export flow (brief)

Export is fully client-side; nothing hits `/api/**`. `ExportBar`
(`src/components/ExportBar.tsx`) holds the buttons:

| Format    | Entry                                          | Derived from |
| --------- | ---------------------------------------------- | ------------ |
| MusicXML  | `downloadMusicXml` (`src/lib/music/export/musicxml.ts`) | the **Score** model directly (full-fidelity 4.0); button hidden when `score` is undefined |
| MIDI      | `downloadMidi` (`src/lib/abc/midi.ts`)         | the rendered **ABC** string via abcjs |
| PDF       | `downloadPdf` (`src/lib/abc/pdf.ts`)           | the rendered **ABC** string via abcjs |

MusicXML is built from the Score (not the ABC) because the ABC string is
lossy for many engraving/structural directives; MIDI and PDF are
acceptable to derive from the abcjs render since they're audio/print
targets.

## See also

- [`../../src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md) — the inner orchestrator loop (dispatch / verify / gate / ghost hook), env flags, rollback
- [`../subsystems/chat-session.md`](../subsystems/chat-session.md) — the client store, history, and edit-persistence queue
- [`../subsystems/ghost-preview.md`](../subsystems/ghost-preview.md) — overlay vs. docked panel, manual-edit interrupt, resume toast
- [`../subsystems/persistence-db.md`](../subsystems/persistence-db.md) — `score_versions` chain, head pointer, CAS / idempotency
- `src/app/api/chat/confirm-replacement/route.ts` — accept/reject CAS + revert-row semantics
- `src/lib/chat/state.ts` — `renderWithMap`, `resolveRequest`, `acceptPendingProposal`
