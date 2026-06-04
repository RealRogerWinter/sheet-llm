---
title: System Architecture Overview
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/app/layout.tsx
  - src/app/page.tsx
  - src/components/HomeClient.tsx
  - src/components/Hero.tsx
  - src/instrumentation.ts
  - src/app/api/chat/route.ts
  - src/lib/orchestrator/index.ts
  - src/lib/music/types.ts
  - src/lib/music/scoreToAbcWithMap.ts
  - src/lib/db/schema.ts
  - src/lib/providers/select.ts
  - src/lib/providers/callWithFailover.ts
  - package.json
related:
  - orchestrator
  - music-model
  - abc-rendering
  - persistence-db
  - chat-session
  - editor-ui
  - providers-llm
---

# System Architecture Overview

sheet-llm is an LLM-driven, publisher-grade music-notation editor. A user
describes or edits a score in natural language; an LLM orchestrator reasons over
a structured **Score** data model and returns a new Score; the Score is
persisted as a versioned checkpoint, transpiled to ABC notation (carrying a
character-range **SourceMap**), and rendered to SVG by `abcjs`. The same SVG is
the direct-manipulation editing surface — clicks and drags hit-test through the
SourceMap back into Score events.

The two load-bearing ideas to internalize first:

1. **The Score is the spine, not the ABC.** Everything — generation, edits,
   versioning, export — operates on the Zod-validated Score tree in
   `src/lib/music/types.ts`. ABC is a *derived* render/serialization format, never
   the source of truth. The LLM is asked to emit Score JSON (via a `render_score`
   tool), not ABC.
2. **The LLM is never trusted to self-report.** Preservation of retained
   measures is verified server-side by hashing (`preservationVerifier`), wholesale
   rewrites are gated behind a confirmation modal (`replacementDetect`), and every
   AI edit is staged as an accept/reject **ghost preview** before it mutates the
   user's score. See [`orchestrator`](../subsystems/orchestrator.md).

## Tech stack

| Layer            | Choice                                              |
| ---------------- | --------------------------------------------------- |
| Framework        | Next.js 16 (App Router), React 19, TypeScript 5     |
| Notation render  | `abcjs` 6 (ABC → SVG, synth playback)               |
| Data model       | Zod 4 schemas (`ScoreSchema` and its subtree)       |
| Persistence      | `better-sqlite3` + Drizzle ORM (file-backed SQLite) |
| Client state     | `zustand` 5 (`useChatStore`)                        |
| LLM              | `@anthropic-ai/sdk`, behind a multi-provider abstraction |
| Auth             | `jose`-signed session JWT (anon identity) + optional accounts: argon2id (`@node-rs/argon2`), OAuth (`arctic`), behind `SL_ACCOUNTS_ENABLED` |
| Export / import  | MusicXML (hand-built from Score), MIDI/PDF (`jspdf`, `svg2pdf.js`, derived from ABC); MusicXML import via `fast-xml-parser` |
| Package manager  | `pnpm` 9 (Node ≥ 20.9)                              |

Verified against `package.json` dependencies at `150cb15`.

## Block diagram

```
 ┌──────────────────────────────── CLIENT (React 19, 'use client') ───────────────────────────────┐
 │                                                                                                  │
 │  src/app/layout.tsx  RootLayout                                                                   │
 │    ├─ themeBootstrap  (inline <head> script: set data-theme pre-paint, no flash)                 │
 │    └─ <RecoveryBoot/> (fetch-interceptor + boot restore of recovery token) ──┐                   │
 │                                                                              │                   │
 │  src/app/page.tsx → src/components/HomeClient.tsx (the editor SPA)            │                   │
 │    mounts session hooks: useChatIdSession / useTranscriptSync /              │                   │
 │    useEditPersistence / useEditorPrefsSync / useChatHistoryShortcut /       │                   │
 │    useAuthSync   ── mounts <AuthModal/> (accounts)                          │                   │
 │      ├─ <SessionSidebar/>  <AppHeader/>  <ChatHistoryPanel/>  <DebugPanel/>  │                   │
 │      └─ <Hero/>  ── composes the editor: ────────────────────────────────┐  │                   │
 │           <PromptBar/>          prompt entry + phases                     │  │                   │
 │           <ScoreStage/>         abcjs SVG host (renders displayedAbc)     │  │                   │
 │           <EditorToolbar/> <NoteFloatingMenu/> popovers                   │  │                   │
 │           <ContextMenu/>        M27 right-click menu (useScoreWheelZoom)   │  │                   │
 │           <CommandPalette/>     ⌘K fuzzy command list                     │  │                   │
 │           <GhostPreviewOverlay/> <GhostPreviewPanel/> <GhostPreviewAmber/> │  │                   │
 │           <ReplacementConfirmModal/> <MeasureDeleteConfirmModal/>          │  │                   │
 │           <TransportBar/> <ExportBar/>                                     │  │                   │
 │                                                                          │  │                   │
 │   ┌──────────────────── zustand store: src/lib/chat/state.ts ───────────┘  │                   │
 │   │ useChatStore: abc, scoreJson, editedScore, editMap (SourceMap),         │                   │
 │   │ history (undo/redo), pendingProposal, paletteRequest, prompt phase      │                   │
 │   └─ submit() in useSubmitPrompt.ts ─────────────────────────── POST ──────┐│                   │
 └────────────────────────────────────────────────────────────────────────────┼┼───────────────────┘
                                                                               ││  fetch (same-origin)
 ┌───────────────────────────── SERVER (Next.js route handlers, runtime=nodejs)┼┼───────────────────┐
 │                                                                             ▼▼                    │
 │  src/instrumentation.ts register():  ensureMigrationsApplied() + reapStalePartials()  (once/boot) │
 │                                                                                                   │
 │  src/app/api/chat/route.ts  POST                                                                  │
 │    ├─ getRequestUser()  (sl_sess account / sl_uid anon JWT) ── auth-gdpr                          │
 │    ├─ resolveGenerationTier(userId)  free|pro paywall ──────── auth-gdpr                          │
 │    ├─ copyright filter → orchestrator.run(input)  src/lib/orchestrator/index.ts                   │
 │    │      ┌──────────────────────────────────────────────────────────────┐                       │
 │    │      │ dispatch: SL_NEW_TOOL_DISPATCH on → 6-tool native dispatcher   │                       │
 │    │      │   (extend/insert/region_replace/intra/regen/answer_question)   │                       │
 │    │      │           off → legacy Haiku classifier                        │                       │
 │    │      │ handler → emits Score + appliedOps                             │                       │
 │    │      │ preservationVerifier (hash retained bars)                      │                       │
 │    │      │ replacementDetect (gate wholesale rewrite)                     │                       │
 │    │      │ maybeAttachGhostProposal (SL_GHOST_PREVIEW on)                 │                       │
 │    │      └────────────────┬─────────────────────────────────────────────┘                       │
 │    │   LLM call via providers abstraction: select.ts → callWithFailover.ts → anthropic/groq/...   │
 │    ├─ validateScore(result.score)                                                                 │
 │    ├─ persist: appendMessages → tryInsertScoreVersionForAssistant (append-only versioned row)     │
 │    └─ response: { score, abc?, ... } + recovery header                                            │
 │                                                                                                   │
 │  Other route handlers (src/app/api/**):                                                           │
 │    sessions/[id]/versions[/batch]  CAS + idempotent version writes      ── persistence-db         │
 │    chat/fork · chat/revert · chat/confirm-replacement                   ── chat / orchestrator    │
 │    import                                                               ── import                 │
 │    auth/restore · me/export · me/delete                                 ── auth-gdpr              │
 │    auth/{signup,login,logout,oauth,verify-email,reset,…}  (SL_ACCOUNTS_ENABLED) ── auth-gdpr      │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼  (response Score → client store)
 ┌──────────────────── PURE LIB (no I/O; runs on both server & client) ──────────────────────────────┐
 │  src/lib/music/types.ts            ScoreSchema tree (Score→measures→events→pitches, spans, …)      │
 │  src/lib/music/validateScore.ts    single validation entry point + cross-ref invariants            │
 │  src/lib/music/editOperations.ts   transformScore() — immutable discriminated-union edit ops        │
 │  src/lib/music/scoreToAbcWithMap.ts  scoreToAbcWithMap() — Score → ABC + char-range SourceMap       │
 │  src/lib/abc/synth.ts              renderScore() — ABC → SVG (abcjs), data-startchar tagging         │
 │  src/lib/music/export/musicxml.ts  scoreToMusicXml() — Score → MusicXML 4.0                          │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Core request flow (prose)

1. **Prompt.** The user types in `PromptBar`; `submit()`
   (`src/lib/chat/useSubmitPrompt.ts`) POSTs the prompt, the current `editedScore`,
   and a `chatId` to `/api/chat`.
2. **Auth + route kernel.** `src/app/api/chat/route.ts` resolves identity via
   `getRequestUser()` (`src/lib/auth/session.ts`) — a DB-backed revocable
   `sl_sess` authenticates a *claimed* account, an `sl_uid` JWT authorizes an
   *unclaimed* anon (a stale `sl_uid` for a claimed account is refused) —
   enforces body-size and turn-count caps (`MAX_BODY_BYTES`, `MAX_USER_TURNS`),
   resolves the product/paywall tier via `resolveGenerationTier(userId)`
   (`free`/`pro`), then calls `runOrchestrator(...)`.
3. **Orchestrate.** `src/lib/orchestrator/index.ts:run` runs the copyright filter,
   dispatches to a handler (6-tool native dispatch when `SL_NEW_TOOL_DISPATCH` is
   on and an `editedScore` is present, otherwise the legacy classifier), executes
   the handler, verifies measure preservation by hashing, runs the replacement
   gate, and — when `SL_GHOST_PREVIEW` is on — attaches a ghost proposal instead
   of a hard apply. The `free` tier is bounded: `regenerate_all` (whole-score
   rewrite) is Pro-only, and a free-tier fall-through returns a clean error
   rather than running the unbounded legacy regen. LLM calls flow through the
   provider abstraction (`selectProvider` → `callWithFailover`).
4. **Validate + persist.** The route validates the returned Score with
   `validateScore`, then appends the assistant message and a new versioned Score
   row through the conversations repository
   (`tryInsertScoreVersionForAssistant`, an O(1) head-pointer append-only write).
5. **Render.** Back on the client, the store transpiles the Score with
   `scoreToAbcWithMap()` — producing the ABC string **and** the `editMap`
   SourceMap — and `renderScore()` paints SVG, tagging noteheads with
   `data-startchar` so the map round-trips clicks back to Score events.
6. **Ghost preview.** If a proposal is pending, `Hero` renders the *candidate*
   ABC (`pendingProposal.abc`) in `ScoreStage` with an accept/reject overlay; the
   user's `editedScore`/`scoreJson` stay at the pre-proposal state until accept.

## Runtime boundaries

There are three classes of module, and the split is intentional and load-bearing:

| Boundary                      | Where                              | Constraints / why it matters |
| ----------------------------- | ---------------------------------- | ---------------------------- |
| **Server route handlers**     | `src/app/api/**/route.ts` (`runtime = 'nodejs'`) | The only place with DB, secrets (`SESSION_SECRET`, `ANTHROPIC_API_KEY`), and LLM I/O. Orchestrator + persistence run here. |
| **Client components**         | `'use client'` files under `src/components/**` and `src/lib/chat/**` | Own all interaction state via `useChatStore`. No secrets; talk to the server only via `fetch` to `/api/**`. |
| **Pure lib**                  | `src/lib/music/**`, `src/lib/abc/**`, parts of `src/lib/orchestrator/**` | No I/O, importable from both sides. The Score model, validation, edit ops, ABC transpile, and exporters live here so they're testable in isolation and reusable client- or server-side. |

Two more boundaries worth knowing:

- **Boot instrumentation** (`src/instrumentation.ts`) runs once per server process
  (gated on `NEXT_RUNTIME === 'nodejs'`): applies pending Drizzle migrations and
  reaps stale `partial` streaming rows. Route handlers therefore never see an
  out-of-date schema.
- **Provider abstraction** (`src/lib/providers/**`) is the seam between the
  orchestrator and any concrete LLM. `selectProvider(tier, chatId)` does
  tier-to-model routing with sticky-per-chat selection; `callWithFailover` runs a
  schema-failure degradation ladder. Defaults are all `anthropic`; with
  `ANTHROPIC_API_KEY` unset the system runs in stub mode.

## Subsystem map

Each row links the deep-dive doc under `docs/subsystems/`. (Per-subsystem
condensed cards for AI agents live under `docs/ai-agents/context-cards/`.)

| Subsystem | One-liner |
| --------- | --------- |
| [music-model](../subsystems/music-model.md) | The Score Zod schema tree (`ScoreSchema`) + `validateScore` single entry point, cross-ref invariants, sanctioned accessors, and the optional-id back-compat rollout. |
| [abc-rendering](../subsystems/abc-rendering.md) | `scoreToAbcWithMap()` transpiles Score → ABC while building the char-range SourceMap; `renderScore()` paints SVG and the click handler round-trips selections back. |
| [edit-operations](../subsystems/edit-operations.md) | Pure immutable Score transforms: a discriminated-union edit-op vocabulary, balanced duration arithmetic, structural splices, smart insertion, content-hash diffing. |
| [orchestrator](../subsystems/orchestrator.md) | The `/api/chat` brain: copyright filter → tool-use dispatch → handler → preservation verify → replacement gate → ghost-preview hook → versioned result. |
| [providers-llm](../subsystems/providers-llm.md) | Multi-provider LLM abstraction: tier-to-model routing, sticky-per-chat selection, schema-failure failover/degradation ladder. |
| [chat-session](../subsystems/chat-session.md) | The client zustand store + hooks owning the live conversation, undo/redo history, proposal slots, prompt phases, and debounced edit persistence. |
| [editor-ui](../subsystems/editor-ui.md) | Direct-manipulation editing: pointer/keyboard hooks hit-testing the abcjs SVG via the SourceMap, plus Dorico-style popover editors. |
| [command-palette](../subsystems/command-palette.md) | The ⌘K/Ctrl-K fuzzy, category-grouped command list dispatching against the store or a nonce-stamped `PaletteRequest` bus. |
| [transport](../subsystems/transport.md) | Transport bar + Web Audio playback engine driving abcjs synth/timing, syncing a highlight cursor and readouts to the store. |
| [ghost-preview](../subsystems/ghost-preview.md) | M24's accept/reject overlay turning every AI edit into a previewed proposal (inline ≤4 events, docked panel ≥5), with manual-edit interrupt + 30s resume toast. |
| [import](../subsystems/import.md) | Converts ABC / MIDI / Score JSON (and a blank seed) into a schema-valid Score, normalizes, and seeds a fresh conversation. |
| [export](../subsystems/export.md) | Exports the Score as MusicXML 4.0 (built from the model) or MIDI/PDF (derived from the rendered ABC), wired via `ExportBar`. |
| [persistence-db](../subsystems/persistence-db.md) | better-sqlite3/Drizzle layer: users (anon + claimed accounts), sessions, transcript, an append-only chain of versioned Score checkpoints with O(1) head pointer, CAS writes, the `auth_sessions`/`oauth_accounts`/`auth_tokens` account tables, and migrations. |
| [auth-gdpr](../subsystems/auth-gdpr.md) | Anonymous identity via a jose-signed session JWT + recovery-token backup + same-origin GDPR export/delete; plus the accounts milestone (email+password+OAuth+settings+paywall tier, behind `SL_ACCOUNTS_ENABLED`) that claims an anon row in place. |

> Note: there is no standalone `docs/subsystems/app-shell.md` or
> `evals-testing.md` at this commit — the App Router shell is described in this
> overview, and the eval/test harness lives in `evals/README.md` and
> `src/lib/orchestrator/README.md`. Add those subsystem docs if the surface grows.

## Key invariants

- **Score is validated at every server boundary.** `validateScore` is the single
  entry point; the orchestrator never trusts an LLM-emitted tree without it.
- **Retained measures must hash-match.** `preservationVerifier` rejects handler
  output that silently mutates bars the user didn't ask to change.
- **Versions are append-only.** `tryInsertScoreVersionForAssistant` advances a
  per-session head pointer under CAS; history is never rewritten in place (forks
  and reverts create new lineage rather than mutating).
- **The SourceMap is the only bridge between Score and SVG.** Selection,
  ghost-preview recolor, and transport cursor all key off `data-startchar` ranges
  produced by `scoreToAbcWithMap()`. If a render path bypasses the map, clicks
  stop round-tripping.
- **Secrets are required at boot.** `SESSION_SECRET` and `RECOVERY_SECRET` throw
  if missing; they are distinct keys. Cookies are `Secure` unless
  `SL_INSECURE_COOKIE_OK` is set (test/e2e only).

## See also

- `src/lib/orchestrator/README.md` — the authoritative orchestrator deep reference (the BAR for these docs).
- `evals/README.md` — the mock/smoke/visual/live eval harness pinning orchestrator behavior.
- `src/app/api/chat/route.ts` — the route kernel and shared chat utilities.
- `src/lib/chat/state.ts` — the canonical client store shape (`useChatStore`).
- `src/lib/music/types.ts` — read `ScoreSchema` + `Event`/`Measure`/`Pitch` first to understand the whole tree.
