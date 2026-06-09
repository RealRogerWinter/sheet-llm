---
title: AI Ghost Preview (M24) — context card
subsystem: ghost-preview
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 90d4c2f
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

Every AI score-edit becomes a previewed proposal: touched noteheads recolor warm-amber on the score (`GhostPreviewAmber`, **any** edit size), plus Accept/Reject chrome that varies by size — inline toolbar (≤4 events) or docked diff panel (≥5). Manual-edit interrupt + 30s resume toast. Gated by `SL_GHOST_PREVIEW` (default ON). Mutually exclusive with the M3.5 replacement gate.

## Key files
- `src/lib/orchestrator/index.ts` — `maybeAttachGhostProposal(result, input)` (~L162, module-private). Calls `ensureEventIds(result.score)` (orchestrator scores lack ids) then sets `result.proposal={affectedEventIds}` + `requiresConfirmation=true`. 5 no-op guards. The noDiff guard also checks `diff.hasAnyVoiceChange === false` so a bass/extra-voice-only edit isn't suppressed (SHE-6).
- `src/lib/orchestrator/flags.ts` — `isGhostPreviewEnabled()` (L112) = `!readExplicitFalse('SL_GHOST_PREVIEW')`.
- `src/lib/music/scoreDiff.ts` — `computeAffectedEventIds(before, after)`; returns AFTER-score ids; `canonEvent` is id-free. Walks **every (staff, voice) pair** (primary + `secondStaff` + each `extraVoices`) via `getStaffCount`/`getVoiceCount`/`getVoiceMeasures`, so the bass clef highlights and a treble note is never a false positive for a bass change (SHE-6). `scoreDiff` also returns `hasAnyVoiceChange` — an all-voice change signal independent of `retainedEventRatio` (which stays primary-staff/voice-0 only so preservation thresholds are untouched).
- `src/lib/shared/types.ts` — `ChatResponse.proposal={affectedEventIds,candidateVersionId}` (L191); `ConfirmReplacementRequest.decision='accept'|'reject'|'dont_ask_again_this_session'` (L207).
- `src/app/api/chat/route.ts` — `gateFired` ⇒ `appendMessages(skipHeadVersionBump:true)`; candidate row stays orphan (~L871-928).
- `src/lib/chat/useSubmitPrompt.ts` — proposal branch (L236-252): `setPendingProposal`, editor NOT swapped; `beforeScore=editedScore??scoreJson??data.scoreJson`.
- `src/lib/chat/state.ts` — `PendingProposal` (L260), `GHOST_PREVIEW_INLINE_THRESHOLD=4` (L241), `computeProposalPresentation` (L252), action impls L1015-1052, 7 interrupt sites (L1243-1801).
- `src/components/orchestrator/GhostPreviewAmber.tsx` — score amber recolor for **any** proposal (both presentations); `useAmberStyleSheet` → `<style>` with two tiers: per-shape `…[data-startchar=N] path,ellipse,rect` (fill+stroke `!important`) + the `<g>` group (fill `!important` + drop-shadow). Mounted once in Hero.
- `src/components/orchestrator/GhostPreviewOverlay.tsx` — inline Accept/Reject toolbar only (amber moved to GhostPreviewAmber).
- `src/components/orchestrator/GhostPreviewPanel.tsx` — diff-panel; `useDiffRows` index-pairs before/after; closes chat panel.
- `src/components/orchestrator/ResumeProposalToast.tsx` — `RESUME_TOAST_TIMEOUT_MS=30_000`; Resume/dismiss/timeout.
- `src/components/Hero.tsx` — mounts `GhostPreviewAmber` + overlay/panel/toast; swaps ScoreStage to candidate abc while a proposal is pending.

## Types / exports
- `PendingProposal`, `PendingProposalPresentation='inline'|'diff-panel'`, `GHOST_PREVIEW_INLINE_THRESHOLD=4`, `computeProposalPresentation()`.
- Store: `pendingProposal`/`interruptedProposal`; `setPendingProposal`/`clearPendingProposal`/`acceptPendingProposal`/`rejectPendingProposal`/`resumeInterruptedProposal`/`clearInterruptedProposal`.
- `isGhostPreviewEnabled()`, `computeAffectedEventIds()`, `RESUME_TOAST_TIMEOUT_MS`.
- Accept/Reject reuse endpoint `/api/chat/confirm-replacement` (NOT a new endpoint).

## Env flags
- `SL_GHOST_PREVIEW` — default **ON**; only `'0'`/`'false'` disables (`readExplicitFalse`). Off ⇒ M3.5 silent-commit. Read per-request.

## Gotchas
- Hook MUST run after replacement gate; no-ops if `result.replacement` or `requiresConfirmation` already set. Replacement wins ties. `useSubmitPrompt` + route check replacement branch first.
- `setPendingProposal` clobbers existing proposal (new prompt abandons prior). Manual-edit path instead stashes → `interruptedProposal`.
- `acceptPendingProposal` resets `history=[candidate]` + bumps epoch ⇒ accept discards undo history.
- Reject/dismiss/30s-timeout leave candidate `score_versions` row orphaned (intentional v1).
- Enter/Esc are capture-phase but bail on TEXTAREA/INPUT/contentEditable focus (else prompt-bar Enter auto-accepts).
- Diff panel index-pairs ⇒ mid-measure insert shows shifted `old[N]→new[N]`, not `(new)`.
- Hook backfills ids first: orchestrator scores have no `id`, so `maybeAttachGhostProposal` calls `ensureEventIds(result.score)` (`eventIds.ts`) before `computeAffectedEventIds`, else amber gets `[]` (the #270 fix). Ids never reach the ABC.
- `retainedEventRatio` is **primary-staff/voice-0 only** by design (preservation + wholesale-rewrite gates depend on its tuned thresholds). A bass-only edit therefore leaves it at 1; the multi-staff `hasAnyVoiceChange` signal is what stops the noDiff gate from suppressing such an edit (SHE-6). Don't widen `retainedEventRatio` to all voices.
- Amber recolors the VISIBLE shapes (`… path,ellipse,rect`) with `fill`+`stroke !important`, not just the `<g>` (abcjs `fill` doesn't inherit to shapes); the `<g>` adds the drop-shadow glow. `!important` beats abcjs's inline fill; drop-shadow doesn't need it.

## When editing X, also update Y
- Add a score-mutating store action → copy the M24-PR-5 interrupt block (7 existing sites: applyEdit/applyBalancedEdit/applyScore/undo/redo/resetEditsToLLM/resolveImport in `state.ts`).
- Change `GHOST_PREVIEW_INLINE_THRESHOLD` → revisit overlay (PR-3) and panel (PR-4) layout assumptions.
- Change `ChatResponse.proposal` shape (`shared/types.ts`) → update route builder, `useSubmitPrompt` branch, and `setPendingProposal` call.
- Touch `computeAffectedEventIds` → affects both presentation threshold and amber/diff rendering.

## Related cards
orchestrator · chat-state · score-diff · replacement-gate · source-map
