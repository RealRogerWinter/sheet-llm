---
title: AI Ghost Preview (M24)
subsystem: ghost-preview
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 36afe91
source_paths:
  - src/lib/orchestrator/index.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/chat/state.ts
  - src/lib/chat/useSubmitPrompt.ts
  - src/app/api/chat/route.ts
  - src/lib/shared/types.ts
  - src/lib/music/scoreDiff.ts
  - src/components/orchestrator/GhostPreviewAmber.tsx
  - src/components/orchestrator/GhostPreviewOverlay.tsx
  - src/components/orchestrator/GhostPreviewPanel.tsx
  - src/components/orchestrator/ResumeProposalToast.tsx
  - src/components/Hero.tsx
related:
  - orchestrator
  - chat-state
  - score-diff
  - replacement-gate
  - source-map
---

## Purpose

Ghost preview (M24) turns every AI score-edit into a *previewed proposal* instead of a
silent commit. After a score-mutating LLM turn, the server holds the new score as an
orphan `score_versions` row and ships the client an `affectedEventIds` set. The client
shows the candidate notation immediately and recolors the touched noteheads warm-amber
**on the score** (any size edit, via `GhostPreviewAmber`), but does **not** advance the
editor's authoritative score. The Accept/Reject chrome differs by edit size: small edits
(≤4 touched events) get an inline floating toolbar; larger edits (≥5) get a 360px
right-docked diff panel that lists the per-event changes alongside the on-score recolor. A
manual edit while a proposal is pending *interrupts* it (stashes it aside), and a 30s
toast offers to resume. The whole flow is gated by `SL_GHOST_PREVIEW` (default ON) and is
mutually exclusive with the M3.5 replacement-confirmation gate.

## Entry points

| Entry | Where |
| --- | --- |
| Server hook | `src/lib/orchestrator/index.ts:maybeAttachGhostProposal` (defined ~L162) |
| Flag resolver | `src/lib/orchestrator/flags.ts:isGhostPreviewEnabled` (L112) |
| Route response builder | `src/app/api/chat/route.ts` (gate branch ~L871-928) |
| Client wiring | `src/lib/chat/useSubmitPrompt.ts` (proposal branch L236-252) |
| Store slots + actions | `src/lib/chat/state.ts` (`PendingProposal` L260, action impls L1015-1052, interrupts) |
| Amber recolor | `src/components/orchestrator/GhostPreviewAmber.tsx:GhostPreviewAmber` (score recolor, both presentations) |
| Inline overlay | `src/components/orchestrator/GhostPreviewOverlay.tsx:GhostPreviewOverlay` (Accept/Reject toolbar) |
| Diff panel | `src/components/orchestrator/GhostPreviewPanel.tsx:GhostPreviewPanel` |
| Resume toast | `src/components/orchestrator/ResumeProposalToast.tsx:ResumeProposalToast` |
| Mount point | `src/components/Hero.tsx` (mounts `GhostPreviewAmber` + overlay/panel/toast) |

## Key files

| Path | Role |
| --- | --- |
| `src/lib/orchestrator/index.ts` | `maybeAttachGhostProposal(result, input)` — module-private hook. Runs after the replacement gate; computes `scoreDiff`, then **`ensureEventIds(result.score)`** (orchestrator results don't carry ids; backfilled deterministically so `computeAffectedEventIds` can resolve them) + `computeAffectedEventIds`, then sets `result.proposal = { affectedEventIds }` and `result.requiresConfirmation = true`. Five guard clauses (see Invariants); the noDiff guard gates on `diff.hasAnyVoiceChange === false` so a bass / extra-voice-only edit is not treated as no-change (SHE-6). |
| `src/lib/orchestrator/flags.ts` | `isGhostPreviewEnabled()` = `!readExplicitFalse('SL_GHOST_PREVIEW')`. Default ON; only literal `'0'`/`'false'` opts out. Read per-request (no module caching) so flips take effect without redeploy. |
| `src/lib/music/scoreDiff.ts` | `computeAffectedEventIds(before, after)`. Iterates **every (staff, voice) pair** — primary + `secondStaff` + each `extraVoices` — via `getStaffCount`/`getVoiceCount`/`getVoiceMeasures` (mirrors `ensureEventIds`), so a bass-clef edit highlights the bass and a bass-only change never falsely highlights treble (SHE-6). Per voice: per-measure `hashMeasure` skip; for overlapping events, `canonEvent` compare; plus all trailing inserted events + all events of inserted measures. Returns **after-score** event ids. `canonEvent` deliberately omits ids. `scoreDiff` also returns `hasAnyVoiceChange` (all-staff/voice change boolean, null when a side is missing), **separate** from `retainedEventRatio` which stays primary-staff/voice-0 only so the preservation / wholesale-rewrite gate thresholds are unchanged. |
| `src/lib/shared/types.ts` | Wire contract. `ChatResponse.proposal = { affectedEventIds, candidateVersionId }` (L191-199), mutually exclusive with `replacement`. `ConfirmReplacementRequest` decision is `'accept' \| 'reject' \| 'dont_ask_again_this_session'` (L207-211). |
| `src/app/api/chat/route.ts` | `gateFired = result.requiresConfirmation === true` ⇒ `appendMessages(..., { skipHeadVersionBump: true })` so the candidate row stays orphan. Response branches: `result.replacement` → `result.proposal` → bare. Proposal payload = `{ affectedEventIds, candidateVersionId: newScoreVersionId }`. |
| `src/lib/chat/useSubmitPrompt.ts` | Proposal branch (L236-252): when `data.requiresConfirmation && data.proposal && data.scoreJson`, calls `endRequestNoScore()` then `store.setPendingProposal(...)`. `beforeScore = editedScore ?? scoreJson ?? data.scoreJson`. **Does not** swap the live `editedScore`. |
| `src/lib/chat/state.ts` | `PendingProposal` type (L260), `GHOST_PREVIEW_INLINE_THRESHOLD = 4` (L241), `computeProposalPresentation` (L252), slots `pendingProposal`/`interruptedProposal`, actions `setPendingProposal`/`clearPendingProposal`/`acceptPendingProposal`/`rejectPendingProposal`/`resumeInterruptedProposal`/`clearInterruptedProposal` (impls L1015-1052). Seven manual-edit interrupt blocks (L1243-1801). |
| `src/components/orchestrator/GhostPreviewAmber.tsx` | Score-level amber recolor for **any** pending proposal (both presentations). Exports `GhostPreviewAmber` + `useAmberStyleSheet`; resolves each affected id → SourceMap `startChar` and emits a single `<style>` with two selector tiers — per-shape `… path,ellipse,rect` (fill+stroke `!important`) for the visible glyph plus the `<g>` group (fill `!important` + drop-shadow glow). Mounted once in Hero, independent of the Accept/Reject chrome. Returns null when there's no proposal / no resolvable ids. |
| `src/components/orchestrator/GhostPreviewOverlay.tsx` | `presentation === 'inline'`. Floating Accept/Reject toolbar + capture-phase Enter/Esc. Early-returns on non-inline. The amber recolor itself moved to `GhostPreviewAmber` (M24 fix) so large edits highlight too. |
| `src/components/orchestrator/GhostPreviewPanel.tsx` | `presentation === 'diff-panel'`. `useDiffRows` builds bar/beat before→after rows via `findEventLocationById` on the candidate score. Closes the chat panel (`setPanelOpen(false)`) when active. Same Enter/Esc + focus guard. |
| `src/components/orchestrator/ResumeProposalToast.tsx` | `RESUME_TOAST_TIMEOUT_MS = 30_000` (exported). Renders when `interruptedProposal` set; Resume → `resumeInterruptedProposal`, `×`/timeout → `clearInterruptedProposal`. Timer re-arms when `candidateVersionId` identity changes. Bottom-left. |
| `src/components/Hero.tsx` | Mounts `<GhostPreviewOverlay/><GhostPreviewPanel/><ResumeProposalToast/>` alongside `<ReplacementConfirmModal/>`. Hero swaps `ScoreStage` to the candidate abc when a proposal is pending (M24-PR-3b). |

## Core concepts / data flow

The proposal slot mirrors M3.5's `pendingConfirmation`: the server creates the candidate
`score_versions` row but does **not** advance `sessions.head_version_id`
(`skipHeadVersionBump: true`). The candidate is *orphan-until-promoted*. `pendingProposal`
holds `chatId`, `candidateVersionId`, `candidateScore`, `beforeScore`, pre-rendered `abc`,
`affectedEventIds`, derived `presentation`, `introText`, `toolUseId`, and optional
`headVersionId`.

```
user prompt
  │
  ▼
/api/chat orchestrator runs chosen handler → result.score
  │
  ▼
maybeAttachGhostProposal(result, input)            [orchestrator/index.ts]
  guards: flag on? editedScore present? no replacement?
          requiresConfirmation not already set? real diff?
  │  yes
  ▼ result.proposal = { affectedEventIds: computeAffectedEventIds(before, after) }
    result.requiresConfirmation = true
  │
  ▼
route.ts: gateFired ⇒ appendMessages(skipHeadVersionBump:true)   ← candidate stays orphan
          ChatResponse { scoreJson: candidate,
                         proposal: { affectedEventIds,
                                     candidateVersionId: newScoreVersionId } }
  │
  ▼
useSubmitPrompt (L236): requiresConfirmation + proposal + scoreJson
  endRequestNoScore()
  store.setPendingProposal({ ..., beforeScore = current editedScore })   ← editor NOT swapped
       └─ setPendingProposal derives presentation from affectedEventIds.length
  │
  ▼
Hero swaps ScoreStage to candidate abc; mounts amber + overlay/panel
  GhostPreviewAmber recolors the touched noteheads amber  (any size edit)
  presentation === 'inline'    → GhostPreviewOverlay (Accept/Reject toolbar, ≤4)
  presentation === 'diff-panel'→ GhostPreviewPanel   (docked diff list, ≥5)
  │
  ├── Accept (Enter) ─► POST /api/chat/confirm-replacement {decision:'accept'}
  │     acceptPendingProposal()           swap editor→candidate, history=[candidate],
  │     setCurrentHeadVersionId(...)       epoch++, clear slot
  │     appendTurns(render_score)
  │
  ├── Reject (Esc) ──► POST /api/chat/confirm-replacement {decision:'reject'}
  │     rejectPendingProposal()            clear slot; server wrote revert row;
  │     setCurrentHeadVersionId(...)       advance local head pointer
  │
  └── manual edit ───► store mutator stashes pendingProposal → interruptedProposal
        ResumeProposalToast (30s)
          Resume  → resumeInterruptedProposal()  (copy slot back; same candidate row)
          dismiss/timeout → clearInterruptedProposal()  (candidate row orphaned)
```

**Inline vs diff-panel threshold.** `GHOST_PREVIEW_INLINE_THRESHOLD = 4`.
`affectedEventIds.length <= 4` → `'inline'`; `>= 5` → `'diff-panel'`.
`computeProposalPresentation` derives it once; `setPendingProposal` stores it explicitly so
subscribers don't recompute on every render. One event id = one touched position (a chord
shares an id across its pitches, so a chord change counts as 1).

**Amber recolor via `data-startchar` piggyback.** Lives in `GhostPreviewAmber`
(mounted once in Hero), and applies to **every** pending proposal regardless of
presentation — inline *and* diff-panel. (Originally the recolor lived inside
`GhostPreviewOverlay` and so only fired for inline ≤4-event edits; diff-panel edits showed
Accept/Reject with no on-score highlight. Because `computeAffectedEventIds` cascades on
insertions, most real edits land in diff-panel — so in practice the highlight almost never
appeared. The M24 fix extracted it to a shared, presentation-agnostic component.)
`useAmberStyleSheet` (exported from `GhostPreviewAmber.tsx`) calls
`scoreToAbcWithMap(candidateScore)`, then for each affected id resolves
`findEventLocationById` → `map.byEvent.get("staff:voice:measure:event")` → `range.startChar`
(deduped via a `Set`). abcjs note/rest SVGs already carry `data-startchar` (tagged by
`ScorePanel.tagNoteheadsWithStartChar` for the drag system), so there is no DOM walking —
and because Hero renders the candidate's abc while a proposal is pending, the rendered
`data-startchar` values line up exactly with the candidate-derived SourceMap offsets. It
emits **two** selector groups (recoloring only the `<g>` does NOT repaint abcjs noteheads —
`fill` inheritance doesn't reach the rendered shapes):
(1) per-shape `.abcjs-note[data-startchar="N"] path, … ellipse, … rect` (+ the rest variants)
with `fill` *and* `stroke` `var(--ghost-amber, #c2570a) !important` — this paints the visible
glyph, mirroring the playback-highlight rule in `src/styles/abcjs-overlay.css`; and
(2) the group `.abcjs-note[data-startchar="N"], .abcjs-rest[data-startchar="N"]` with `fill`
`!important` plus a `drop-shadow(0 0 3px var(--ghost-amber))` glow. `!important` is required
because abcjs writes inline `fill` on noteheads at render; the `drop-shadow` filter does not
need `!important`.

**Accept/Reject via `/api/chat/confirm-replacement`.** Both overlay and panel POST
`{ chatId, candidateVersionId, decision }` to the *existing* M3.5-PR-4 endpoint (not a new
one) — its accept/reject CAS semantics are exactly what ghost preview needs. On accept,
`acceptPendingProposal()` swaps the editor to the candidate, resets `history` to
`[candidateScore]`, bumps `epoch`, clears the slot; the component then calls
`setCurrentHeadVersionId(data.headVersionId)` and appends a `render_score` transcript turn.
On reject, the server writes a revert row and the client advances its head pointer.

## Invariants & gotchas

- **Order is load-bearing.** `maybeAttachGhostProposal` runs *after* the replacement gate
  and no-ops when `result.replacement` or `result.requiresConfirmation === true` is already
  set. Both `useSubmitPrompt` and `route.ts` check the `replacement` branch before the
  `proposal` branch, so a turn is never both — and if both were ever populated, replacement
  wins (it owns the "don't ask again this session" modal the proposal flow doesn't replicate).
- **The five no-op guards** in the hook (silent commit, no proposal): flag off; no
  `input.editedScore` (compose-from-scratch — nothing to diff against); `result.replacement`
  set; `result.requiresConfirmation` already true (preview-mode `regenerate_all`); the diff
  is a no-op (`hasAnyVoiceChange === false && retainedEventRatio === 1 && measureCount
  unchanged && !keyChanged && !meterChanged && !titleChanged`). The
  `hasAnyVoiceChange === false` conjunct (SHE-6) keeps a bass-clef / extra-voice-only
  edit out of the no-op bucket — `retainedEventRatio` alone is primary-staff/voice-0
  only and blind to non-primary staves/voices, so without it a bass-only edit was
  wrongly suppressed.
- **`setPendingProposal` clobbers** any existing `pendingProposal` with no guard —
  submitting a *new* prompt implicitly abandons a prior proposal. This is distinct from the
  manual-edit path, which preserves it via `interruptedProposal`.
- **Seven manual-edit interrupt sites.** `applyEdit`, `applyBalancedEdit`, `applyScore`,
  `undo`, `redo`, `resetEditsToLLM`, and `resolveImport` each carry a near-identical block
  that moves `pendingProposal` → `interruptedProposal`. (Six use
  `interruptedProposal: state.pendingProposal`; `resolveImport` uses `get().pendingProposal`.)
  **Adding a new score-mutating store action requires copying this block**, or the proposal
  will linger stale through a manual edit.
- **Accept discards undo history.** `acceptPendingProposal` resets `history` to
  `[candidateScore]` and bumps `epoch`. Accepting an AI proposal throws away local undo
  history — unlike a normal manual edit, which appends to history.
- **Reject and dismiss/timeout both orphan the candidate row.** The candidate
  `score_versions` row is no longer reachable from the head chain. Intentional v1 behavior
  matching the replacement-modal-Esc pattern; orphan cleanup is a deferred cron concern.
- **Capture-phase keyboard with a focus guard.** Enter/Esc handlers use
  `window.addEventListener('keydown', onKey, true)` to beat editor listeners, but bail when
  an editable element (`TEXTAREA`/`INPUT`/`contentEditable`) is focused — otherwise pressing
  Enter in the prompt textarea would silently accept the proposal.
- **Diff panel pairs by index, not by id.** `useDiffRows` looks up the BEFORE event at the
  *same* `(measureIdx, eventIdx)` as the AFTER event. A mid-measure INSERT therefore reads as
  shifted `old[N] → new[N]` pairings rather than `(new) → inserted`. Positionally correct but
  doesn't convey structural insertion. `canonEvent` deliberately omits ids, so id-pairing was
  rejected (over-reports on a no-op rewrite with fresh uuids) in favor of index-pairing.
- **The hook backfills ids before diffing.** `computeAffectedEventIds` keys off event `id`,
  but orchestrator results don't carry ids (`id` is optional and otherwise only set on the
  migrate-on-load path), so without help it would return `[]` and nothing would highlight.
  `maybeAttachGhostProposal` therefore calls `ensureEventIds(result.score)`
  (`src/lib/music/eventIds.ts`, deterministic + idempotent `deriveEventId`) **before**
  computing the affected set; ids never appear in the ABC, so the rendered notation is
  unchanged. (This was the #270 fix — previously the amber highlight effectively never
  appeared because the candidate had no ids.)

## How to extend / common tasks

- **Add a new score-mutating store action** → copy the M24-PR-5 interrupt block (stash
  `pendingProposal` → `interruptedProposal`, clear `pendingProposal`) before the mutation, or
  the proposal lingers stale. See the seven existing sites in `src/lib/chat/state.ts`.
- **Change the inline/panel cutover** → edit `GHOST_PREVIEW_INLINE_THRESHOLD` in
  `src/lib/chat/state.ts`. It is the single source of truth; the comment notes both PR-3
  (overlay) and PR-4 (panel) layout assumptions depend on it.
- **Change what counts as a "real" diff** → the no-op predicate lives in
  `maybeAttachGhostProposal` (`src/lib/orchestrator/index.ts`), keyed off `scoreDiff` fields.
- **Improve diff-row pairing for insertions** → replace the index-pairing in `useDiffRows`
  (`GhostPreviewPanel.tsx`) with Myers/LCS pairing across measures (deferred in v1).
- **Tune the resume window** → `RESUME_TOAST_TIMEOUT_MS` in `ResumeProposalToast.tsx`.
- **Disable the whole feature** → `SL_GHOST_PREVIEW=0` (or `false`); reverts to M3.5
  silent-commit. No redeploy needed (read per-request).

### Env flags

| Flag | Default | Effect |
| --- | --- | --- |
| `SL_GHOST_PREVIEW` | **on** | Master switch (`isGhostPreviewEnabled`). `0`/`false` ⇒ orchestrator silently commits scores; overlay/panel/toast never fire (reverts to M3.5 silent-commit). `readExplicitFalse` semantics: only literal `'0'`/`'false'` disables; any other/absent value leaves it ON (default since M24-PR-6). Read per-request. |

## Testing

| Test | Covers |
| --- | --- |
| `tests/unit/orchestrator/ghostPreviewGate.integration.test.ts` | Server hook gating + no-op cases |
| `tests/unit/orchestrator/flags.test.ts` | `SL_GHOST_PREVIEW` default + opt-out resolution |
| `tests/unit/orchestrator/replacementGate.integration.test.ts` | Mutual-exclusivity sibling |
| `tests/unit/components/GhostPreviewAmber.test.tsx` | Score amber recolor for **both** presentations + real-abcjs render integration (selector matches rendered noteheads) |
| `tests/unit/components/GhostPreviewOverlay.test.tsx` | Inline Accept/Reject toolbar + keyboard; asserts it no longer self-injects the amber `<style>` |
| `tests/unit/components/GhostPreviewPanel.test.tsx` | Docked diff panel rows / accept-all |
| `tests/unit/components/ResumeProposalToast.test.tsx` | Resume / dismiss / 30s timeout |
| `tests/unit/chat/interruptedProposal.test.ts` | Manual-edit interrupt stashing |
| `tests/unit/chat/pendingProposal.test.ts` | Proposal slot + presentation derivation |
| `tests/integration/useSubmitPrompt.test.tsx` | Client wiring of the proposal branch |
| `tests/unit/components/Hero.test.tsx` | Mount + candidate-abc swap |

## Related files / See also

- `src/lib/orchestrator/README.md` — orchestrator architecture, "AI ghost preview (M24)"
  section (~L163) and the replacement gate it is mutually exclusive with.
- `src/components/orchestrator/ReplacementConfirmModal.tsx` — the M3.5 wholesale-replacement
  gate; ghost preview reuses its `/api/chat/confirm-replacement` endpoint and CAS pattern.
- `src/lib/music/scoreDiff.ts` — `computeAffectedEventIds`, `canonEvent`, `hashMeasure`.
- `src/lib/music/scoreToAbcWithMap.ts` + `src/lib/music/scoreAccessors.ts:findEventLocationById`
  — SourceMap resolution used by the amber overlay.
- `src/components/ScorePanel.tsx` — tags `data-startchar` on abcjs note/rest SVGs (the
  attribute `GhostPreviewAmber` piggybacks on) via `tagNoteheadsWithStartChar`.
