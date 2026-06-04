---
title: AI Agent Guide — Orientation for Coding Agents
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - AGENTS.md
  - CLAUDE.md
  - docs/architecture/overview.md
  - docs/guides/development-workflow.md
  - src/lib/orchestrator/README.md
  - src/lib/orchestrator/flags.ts
  - src/lib/music/types.ts
  - src/lib/music/validateScore.ts
  - evals/README.md
  - package.json
related:
  - orchestrator
  - music-model
  - ghost-preview
  - evals-testing
  - app-shell
---

# AI Agent Guide

You are an AI coding agent maintaining **sheet-llm** — an LLM-driven,
publisher-grade music-notation editor (Next.js 16, React 19, TypeScript,
Drizzle/SQLite, abcjs, zustand). This is the doc the project owner wrote
*for you*. Read it before you touch code. It is purely navigational:
where to look, what not to break, how to prove your change is correct.

If you read nothing else, internalize the two load-bearing ideas from
[`../architecture/overview.md`](../architecture/overview.md):

1. **The Score is the spine, not the ABC.** Generation, edits,
   versioning, and export all operate on the Zod-validated Score tree in
   `src/lib/music/types.ts`. ABC is a *derived* render/serialization
   format, never the source of truth.
2. **The LLM is never trusted to self-report.** Retained measures are
   re-hashed server-side, wholesale rewrites are gated behind a modal,
   and every AI edit is staged as an accept/reject ghost preview before
   it mutates the user's score.

---

## Fastest path to context

Do not grep the whole tree on a cold start. Follow this funnel — each
step narrows scope and is short:

```
1. AGENTS.md  (repo root)
   └─ the "this is NOT the Next.js you know" warning + orchestrator pointer.
      CLAUDE.md just @-includes AGENTS.md — same content.

2. docs/architecture/overview.md
   └─ the spine, the tech stack, the end-to-end request flow, the
      subsystem map. ~10 min. Gives you the mental model.

3. docs/ai-agents/context-cards/<subsystem>.md
   └─ the ONE card for the area you're touching. Dense: key files,
      key exports/types, env flags, gotchas. Optimized for agents.

4. (only if the card isn't enough)
   docs/subsystems/<subsystem>.md   — the long-form deep doc
   src/lib/orchestrator/README.md   — authoritative for the orchestrator
   the actual source files the card lists in `source_paths`.
```

**Grounding rule (non-negotiable):** every path, export, type, and flag
you rely on must be one you opened on disk *at the current commit*. Cards
and docs carry `last_verified` / `verified_against` frontmatter, but code
moves — if a card disagrees with the file, the file wins (and you should
fix the card; see [Update the docs](#update-the-docs-when-you-change-code)).

---

## Context-card index

The 16 cards under [`context-cards/`](context-cards/) are the per-subsystem
entry points. Each lists key files, exports/types, env flags, and the
non-obvious gotchas for that area. Start at the card whose slug matches
your task; it cross-links to the deep doc.

| Card | What it covers |
| ---- | -------------- |
| [`music-model`](context-cards/music-model.md) | The `Score` Zod tree (measures → events → pitches, spans/markers/voltas/jumps/techniques/engravingDefaults), `validateScore`, cross-ref invariants, the sanctioned accessor layer, the optional-id back-compat rollout. |
| [`abc-rendering`](context-cards/abc-rendering.md) | Score → ABC transpile with a character-range **SourceMap**, abcjs SVG render, the ink-condensing reveal, and how a click round-trips SVG → Score selection. |
| [`edit-operations`](context-cards/edit-operations.md) | Pure immutable Score transforms: the discriminated-union edit-op vocabulary, measure-balance arithmetic, structural splices with index remap, smart insert, content-hash diffing. |
| [`orchestrator`](context-cards/orchestrator.md) | The `/api/chat` brain: copyright filter → tool-use dispatch → handler → preservation verify → replacement gate → ghost-preview proposal → versioned Score. |
| [`providers-llm`](context-cards/providers-llm.md) | Multi-provider LLM abstraction: tier→model routing, sticky-per-chat selection, schema-failure degradation/failover ladder, plus the legacy single-Anthropic client. |
| [`import`](context-cards/import.md) | ABC / MIDI / Score-JSON / blank-seed → schema-valid Score, shared normalization (anacrusis pad + length truncate), and fresh-chat seeding. |
| [`export`](context-cards/export.md) | Score → MusicXML 4.0 (built from the model), and MIDI / PDF derived from the rendered ABC; wired by `ExportBar`. |
| [`persistence-db`](context-cards/persistence-db.md) | better-sqlite3/Drizzle layer: users, sessions, transcript messages, append-only versioned Score checkpoints, O(1) head pointer, CAS-guarded writes, lazy schema-version migration, forensic `orchestrator_turns`. |
| [`auth-gdpr`](context-cards/auth-gdpr.md) | Cookie-less anonymous identity via jose-signed httpOnly JWT, localStorage recovery-token backup, same-origin-gated GDPR export (Art. 15/20) and hard-delete (Art. 17). |
| [`chat-session`](context-cards/chat-session.md) | The client zustand store + hooks: live conversation, undo/redo score history, proposal/confirmation slots, prompt-bar phases, debounced/beaconed edit persistence. |
| [`editor-ui`](context-cards/editor-ui.md) | Direct-manipulation editor: mount-once pointer/keyboard hooks over the abcjs SVG, SourceMap-tagged hit-testing, and the Dorico-style popover editors. |
| [`command-palette`](context-cards/command-palette.md) | The Cmd-K/Ctrl-K palette: fuzzy-searchable category-grouped commands that dispatch to the chat-store or publish a nonce-stamped `PaletteRequest` on a single-slot bus. |
| [`transport`](context-cards/transport.md) | Transport bar + Web Audio playback engine driving abcjs CreateSynth/TimingCallbacks, syncing a highlight cursor and measure/time readouts. |
| [`ghost-preview`](context-cards/ghost-preview.md) | M24's accept/reject overlay: inline amber overlay (≤4 events) vs docked diff panel (≥5), manual-edit interrupt + 30s resume toast, gated by `SL_GHOST_PREVIEW`. |
| [`app-shell`](context-cards/app-shell.md) | The Next.js 16 App Router shell: SPA editor at `/`, `/settings`, root-layout boot wiring, startup instrumentation (migrations + janitor), full `/api/**` route inventory. |
| [`evals-testing`](context-cards/evals-testing.md) | The four-tier eval harness (mock/smoke/visual/live) pinning orchestrator contracts, plus vitest unit/integration + Playwright e2e, all run locally / on demand. |

---

## Golden rules of this codebase

These are the invariants the code actively enforces. Violating one is how
you ship a regression that the maintainers built whole subsystems to
prevent.

### 1. Never silently replace user work

This is the founding incident (the M3.5 triplet-demo bug: "add 4 more
bars" silently rewrote the whole piece). The defenses are layered and
**default-on** — do not weaken them:

- **Server-side preservation verify** — `src/lib/orchestrator/preservationVerifier.ts`
  re-hashes the measures a handler was supposed to leave untouched and
  refuses the result if any hash drifts. The LLM is never trusted to
  self-report preservation.
- **Replacement-as-confirmation gate** — `src/lib/orchestrator/replacementDetect.ts`
  fires when >50% of measures are no longer byte-identical AND meta
  (key/meter/title) changed AND the prompt lacked explicit rewrite
  intent. Result gets `requiresConfirmation = true`; head pointer does
  not advance until the user accepts.
- **Ghost preview** — every AI score edit is staged as an accept/reject
  proposal before mutating the user's score (`SL_GHOST_PREVIEW`, on).

Full mechanics in [`../../src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md).

### 2. Additive edits, not wholesale rewrites

When the user asks to *add* or *change part* of a score, the dispatcher
should pick `extend_composition` / `insert_measures` / `region_replace` /
`edit_intra_measure` — not `regenerate_all`. `regenerate_all` requires
`confirmExplicitRewrite: true` + a `justification` and is itself gated.
If you're adding a new edit capability, make it additive and route it
through a scoped handler, not a full recompose.

### 3. This is NOT the Next.js you know

Verbatim from [`../../AGENTS.md`](../../AGENTS.md): this version has
breaking changes — APIs, conventions, and file structure may all differ
from your training data. **Read the relevant guide in
`node_modules/next/dist/docs/` before writing any Next.js code** (route
handlers, App Router conventions, `instrumentation.ts`, server/client
boundaries). Heed deprecation notices. Do not pattern-match from memory.

### 4. Schema-drift discipline

The Score schema (`src/lib/music/types.ts`) is the spine and the DB
schema (`src/lib/db/schema.ts`) is append-only and migration-backed.

- **Score schema:** every Score that enters the system goes through
  `validateScore` (`src/lib/music/validateScore.ts`) — the single
  validation entry point (parse + bar-align + duration + tuplet +
  cross-refs). Don't bypass it. Mutate the Score via the pure transforms
  in `edit-operations`, not ad-hoc. Use only the sanctioned accessor
  layer (`src/lib/music/scoreAccessors.ts`) to walk the measure list.
- **DB schema:** if you edit `src/lib/db/schema.ts` you MUST regenerate
  the Drizzle SQL (`pnpm db:generate`) and commit `drizzle/*.sql`, or the
  schema and the committed migrations drift. After running `pnpm db:generate`,
  confirm `git status` shows no unexpected `drizzle/*.sql` changes.

### 5. Feature-flag rollout

Behavior-changing work lands behind an env flag, defaults are flipped in
a later PR, and every flag has a documented rollback. Flags are read
fresh on every call (`src/lib/orchestrator/flags.ts`) — never cached — so
a rollback is an env change, not a redeploy. Current orchestrator flags
(see the README's flag table for the authoritative list):

| Flag | Default | Effect of flipping |
| ---- | ------- | ------------------ |
| `SL_NEW_TOOL_DISPATCH` | on | `0` → legacy Haiku classifier path |
| `SL_REPLACEMENT_GATE` | on | `0` → skip the replacement gate; head advances silently |
| `SL_GHOST_PREVIEW` | on | `0` → orchestrator silently commits scores (pre-M24) |
| `SL_GENERATION_TIER` | free | **M26** product/paywall tier (orthogonal to model-size tier). `free` routes a fresh from-scratch generation to the bounded ≤4-bar single-call handler; `pro` keeps the sectional/whole-score pipeline. Resolved per request in `generationTier.ts`. |
| `SL_BOUNDED_GEN` | on | **M26** the free-tier bounded handler. `0`/`false` reverts free users to the legacy/sectional path WITHOUT opening the paywall (independent rollback). |
| `SL_SECTIONAL_GEN` | on | `0`/`false` → the **pro** (non-bounded) fresh-generation path falls back to single-shot `runGenerateComplex` instead of sectional streaming. (Free-tier fresh prompts are intercepted by `SL_BOUNDED_GEN` before this fork.) |
| `SL_STREAM_ABORT` | off | **M26** opt-in secondary streaming kill-switch (output-token + wall-clock abort on the converse/text `textStream` path). |
| `SL_COMPOSE_PATCH_DISPATCH` | off | **Deprecated**; ignored under the new dispatcher |
| `ORCHESTRATOR_KILL` | unset | `1` → every `/api/chat` falls through to legacy single-shot |
| `ORCHESTRATOR_ENABLED` | on | `false`/`0` → orchestrator off at the route level |
| `ORCHESTRATOR_MODE` | primary | `shadow` → run alongside legacy, legacy wins, divergence logged |

When you add a flag, give it a default, document the effect + rollback,
and read it through `flags.ts` (or the equivalent accessor for the
subsystem) rather than touching `process.env` inline.

---

## How to verify a change

Run these locally before you claim a change is done. The package manager
is **pnpm** (`pnpm@9.15.9`); scripts also alias under `npm run`.

```sh
pnpm typecheck      # tsc --noEmit — must be clean
pnpm test           # vitest unit + integration (excludes evals + e2e)
pnpm lint           # eslint
```

If you touched the orchestrator, the Score model, edit operations, or
anything that changes what the AI applies to a Score, also run the
relevant **eval tier**. The four tiers (from [`../../evals/README.md`](../../evals/README.md)):

| Tier | Script | Spend | When |
| ---- | ------ | ----- | ---- |
| Mock | `pnpm eval:mock` | $0 (stubs the provider) | Run locally — start here |
| Smoke | `pnpm eval:smoke` | ~$0.001 (a few Haiku calls) | Run locally before merging |
| Visual | `pnpm eval:visual` | $0 (deterministic abcjs render + path-distance diff) | Renderer changes |
| Live | `pnpm eval:live` | per case (real Sonnet) | On demand |

Live evals are skipped unless `RUN_LIVE_EVALS=1` and an `ANTHROPIC_API_KEY`
is present; the heavy cases need `RUN_LIVE_FULL=1`. Don't run live evals
casually — they cost real money. The mock + visual tiers are free and
deterministic; run those.

Other checks:
- **Schema drift** — after `schema.ts` edits, `pnpm db:generate` then
  confirm `git status` shows no unexpected `drizzle/*.sql` changes.
- **Forensic replay** — to triage "the AI did something weird", replay a
  session: `pnpm replay -- --session <id>` (redacted) /
  `--unsafe-include-content` (full). See the orchestrator README.
- **e2e** — Playwright suites live under `tests/e2e/`; see
  [`evals-testing`](context-cards/evals-testing.md) and
  [`../guides/development-workflow.md`](../guides/development-workflow.md)
  for the eval tiers (run locally / on demand).

---

## Update the docs when you change code

The docs are staleness-tracked via frontmatter. When your change affects
a file listed in a doc's `source_paths`:

1. Update the prose if behavior changed (flags, defaults, invariants,
   export names, file moves).
2. Bump that doc's `last_verified` to today and `verified_against` to the
   commit short SHA you verified against.
3. If you added/removed a source file the doc describes, update its
   `source_paths` — that list drives staleness detection.

Every markdown doc in this tree begins with the frontmatter contract
(`title`, `subsystem`, `audience`, `status`, `last_verified`,
`verified_against`, `source_paths`, `related`). New docs must too. Match
the tone of [`../../src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md):
precise, dense, code-referenced, WHY-over-WHAT. Reference code as
relative paths with symbols (e.g. `src/lib/music/validateScore.ts:validateScore`),
and never assert a path/export/flag you didn't open.

---

## See also

- [`../../AGENTS.md`](../../AGENTS.md) — the root warning + orchestrator pointer (CLAUDE.md @-includes it)
- [`../architecture/overview.md`](../architecture/overview.md) — system mental model
- [`../architecture/data-flow.md`](../architecture/data-flow.md) — end-to-end request flow
- [`../architecture/glossary.md`](../architecture/glossary.md) — domain vocabulary
- [`../guides/development-workflow.md`](../guides/development-workflow.md) — branch/PR flow, local checks, eval tiers
- [`../../src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md) — authoritative orchestrator reference
- [`../../evals/README.md`](../../evals/README.md) — the four-tier eval harness
- [`context-cards/`](context-cards/) — the 16 per-subsystem agent cards
- [`../subsystems/`](../subsystems/) — the long-form deep docs
