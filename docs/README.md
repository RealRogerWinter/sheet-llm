---
title: sheet-llm Documentation Hub
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - docs/architecture/overview.md
  - docs/guides/getting-started.md
  - docs/architecture/data-model.md
  - docs/ai-agents/AGENT_GUIDE.md
  - docs/ai-agents/maintenance-protocol.md
  - docs/_meta/STYLE_GUIDE.md
related:
  - overview
  - getting-started
  - data-model
  - orchestrator
  - music-model
---

# sheet-llm Documentation

sheet-llm is a chat-driven music notation editor. You describe music in
natural language; an LLM **orchestrator** turns the request into
*additive* edit operations against a canonical JSON `Score`, which is
rendered to staff notation via abcjs, played back through a transport,
and exported to MusicXML / MIDI / PDF. The defining invariant is
**additive editing**: the system never silently rewrites work the user
didn't ask to replace (server-side preservation verification plus a
replacement-as-confirmation gate enforce this).

This `docs/` tree is the canonical, frontmatter-stamped documentation
set. Every doc declares the `source_paths` it describes so staleness can
be detected mechanically — see
[`_meta/coverage.md`](_meta/coverage.md) and the freshness checker in
[`reference/scripts.md`](reference/scripts.md).

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the whole system in one pass | [Architecture Overview](architecture/overview.md) |
| Get the app running locally | [Getting Started](guides/getting-started.md) |
| Understand the central `Score` type | [The Score Data Model](architecture/data-model.md) |
| Onboard as an AI coding agent | [AI Agent Guide](ai-agents/AGENT_GUIDE.md) |

## Architecture

| Doc | Description |
| --- | --- |
| [System Architecture Overview](architecture/overview.md) | End-to-end map: app shell → chat → orchestrator → score → render/play/export. |
| [Request Lifecycle](architecture/data-flow.md) | Step-by-step data flow for a chat edit, an import, and an export. |
| [The Score Data Model](architecture/data-model.md) | The canonical `Score` JSON: measures, events, spans, IDs, validation, migration. |
| [Glossary](architecture/glossary.md) | Domain and system terms (additive edit, SourceMap, sticky provider, score version, …). |

## Subsystems

| Doc | Description |
| --- | --- |
| [LLM Orchestrator](subsystems/orchestrator.md) | Native tool-use dispatch, preservation verifier, replacement gate, budget/deadline. |
| [LLM Providers & Failover](subsystems/providers-llm.md) | Provider registry, tiered selection, sticky routing, degradation, failover. |
| [Music Data Model & Validation](subsystems/music-model.md) | Types, validators, accessors, meter, spans, techniques, articulations, dynamics. |
| [Edit Operations & Score Transforms](subsystems/edit-operations.md) | The edit-op catalog, structural ops, measure balancing, diffing. |
| [Score-to-ABC, SourceMap & abcjs Rendering](subsystems/abc-rendering.md) | Score→ABC emit, the SourceMap round-trip, abcjs render/synth, reveal animation. |
| [Notation Editor UI & Interactions](subsystems/editor-ui.md) | Click/drag/keyboard editing, staff geometry, popovers, floating menu. |
| [Command Palette (Cmd-K)](subsystems/command-palette.md) | Command catalog, palette UI, dispatch bus into editor/chat state. |
| [AI Ghost Preview (M24)](subsystems/ghost-preview.md) | Inline amber overlay, docked diff panel, accept/reject, 30s resume toast. |
| [Chat & Session State (client)](subsystems/chat-session.md) | Client chat store, prompt submit/phase, transcript sync, persistence queue. |
| [Transport & Playback](subsystems/transport.md) | Transport state machine, cursor, scrubber, event-time index, MIDI/ping audio. |
| [Score Import Pipeline](subsystems/import.md) | Format detect → ABC/MIDI/JSON → normalized `Score`, import modal/preview. |
| [Export — MusicXML, MIDI, PDF](subsystems/export.md) | MusicXML emit, MIDI/PDF generation, export bar. |
| [Persistence, Schema & Score Versioning](subsystems/persistence-db.md) | Drizzle schema, conversations, score versions, fork/revert, janitor/retention. |
| [Auth, Sessions & GDPR](subsystems/auth-gdpr.md) | Anonymous sessions + the accounts milestone (email/password/OAuth/settings/paywall tier, behind `SL_ACCOUNTS_ENABLED`), recovery codes, rate limiting, GDPR export/delete. |
| [Auth Data Lifecycle](subsystems/auth-data-lifecycle.md) | Account-table retention, the opportunistic janitor/GC, and breach-response secret rotation. Companion to auth-gdpr. |
| [App Shell, Routes & Boot](subsystems/app-shell.md) | Root layout, boot/instrumentation, recovery boot, page composition. |
| [Testing & Eval Harness](subsystems/evals-testing.md) | Vitest configs, factories, mock/live/visual evals, local check commands. |

## Guides

| Doc | Description |
| --- | --- |
| [Getting Started](guides/getting-started.md) | Contributor onboarding: env, DB, providers, first run. |
| [Development Workflow](guides/development-workflow.md) | Branch/PR flow, flags, eval tiers, local check commands. |
| [Adding an Edit Operation](guides/adding-an-edit-operation.md) | Recipe: wire a new edit op through transforms, validation, orchestrator, keyboard. |
| [Adding a Notation Feature](guides/adding-a-notation-feature.md) | End-to-end recipe: type → ABC → render → tool → MusicXML → palette. |
| [Adding an LLM Provider](guides/adding-a-provider.md) | Recipe: register a provider, selection tiers, failover, system blocks. |
| [Durability & Restore Runbook](guides/durability-runbook.md) | Litestream WAL-to-object-storage replication, the `SL_REQUIRE_WAL` launch gate, and restore procedure. |
| [Self-Hosted VPS Deployment](guides/deploy-vps.md) | Production topology: Cloudflare → Caddy → Docker → Litestream/R2; image, container start sequence, host layout, pull-based deploy. |
| [Security Hardening & Threat Model](guides/security-hardening.md) | Defense-in-depth: origin lock (ufw CF-IP + AOP mTLS), host hardening, secret hygiene, LLM cost-abuse controls (rate limit + Turnstile). |
| [CI/CD Pipeline & Build-in-Public](guides/ci-cd-pipeline.md) | The CircleCI gate (timing-split tests, schema-drift), build→approve→deploy, and the build-in-public philosophy. |
| [Local models (Ollama)](local-models.md) | Run sheet-llm against a local Ollama LLM for offline/zero-cost dev. |

## Reference

| Doc | Description |
| --- | --- |
| [API Routes Reference](reference/api-routes.md) | Every `src/app/api/**` route: method, auth, request/response shape. |
| [Environment Flags & Config](reference/env-flags.md) | All env flags with defaults and effects (orchestrator, providers, auth, db). |
| [npm Scripts & the scripts/ Directory](reference/scripts.md) | What each `package.json` script and `scripts/*.ts` utility does. |

## Contributing

| Doc | Description |
| --- | --- |
| [Contributing to sheet-llm](contributing/CONTRIBUTING.md) | Repo conventions, local checks, commit/PR norms, the additive-edit contract. |

## AI agents

| Doc | Description |
| --- | --- |
| [AI Agent Guide](ai-agents/AGENT_GUIDE.md) | Orientation for coding agents: golden rules, where things live, how to verify. |
| [Documentation Maintenance Protocol](ai-agents/maintenance-protocol.md) | How to keep docs and frontmatter fresh; what the freshness check enforces. |
| [Documentation Style Guide](_meta/STYLE_GUIDE.md) | Frontmatter contract and writing style every doc must follow. |
| [Doc Coverage & Freshness Map](_meta/coverage.md) | Regenerable table of every doc with its source_paths count and verified SHA. |
| [llms.txt](llms.txt) | Machine-readable navigation map for agents (llms.txt convention). |

Per-subsystem **context cards** for agents live under
[`ai-agents/context-cards/`](ai-agents/context-cards/) — terse,
high-signal companions to the subsystem docs above (abc-rendering,
app-shell, auth-gdpr, chat-session, command-palette, edit-operations,
editor-ui, evals-testing, export, ghost-preview, import, music-model,
orchestrator, persistence-db, providers-llm, transport).

## How this documentation is organized

```
docs/
├── README.md            ← you are here (human hub)
├── llms.txt             ← machine-readable map for AI agents
├── architecture/        ← cross-cutting: overview, data-flow, data-model, glossary
├── subsystems/          ← one doc per subsystem (the "what & how")
├── guides/              ← task recipes (getting started, adding X, durability runbook)
├── reference/           ← lookup tables (api routes, env flags, scripts)
├── contributing/        ← contribution conventions
├── ai-agents/           ← agent guide, maintenance protocol, context cards
├── testing/             ← smoke/e2e test runbook
├── local-models.md      ← Ollama setup (guide)
└── _meta/               ← style guide + coverage/freshness map
```

Every markdown doc (except `llms.txt`, which follows the plain
llms.txt format) begins with YAML frontmatter declaring `title`,
`subsystem`, `source_paths`, `last_verified`, and `verified_against`.
The `source_paths` list is load-bearing: it is what the freshness
tooling diffs against git to flag docs whose code has changed.

## Maintenance

When you change code, update the doc whose `source_paths` includes the
file you touched, then bump its `last_verified` / `verified_against`.
The full protocol is in
[`ai-agents/maintenance-protocol.md`](ai-agents/maintenance-protocol.md);
the contract every doc obeys is in
[`_meta/STYLE_GUIDE.md`](_meta/STYLE_GUIDE.md); coverage is tracked in
[`_meta/coverage.md`](_meta/coverage.md). Agents should start from the
[AI Agent Guide](ai-agents/AGENT_GUIDE.md).

## See also

- [`../AGENTS.md`](../AGENTS.md) — top-level agent instructions (Next.js caveats, orchestrator summary).
- [`../src/lib/orchestrator/README.md`](../src/lib/orchestrator/README.md) — orchestrator architecture and flag reference.
- [`../evals/README.md`](../evals/README.md) — mock + live eval harness.
