---
title: Doc Coverage & Freshness Map
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - docs/_meta/STYLE_GUIDE.md
  - docs/ai-agents/maintenance-protocol.md
  - docs/reference/scripts.md
related:
  - maintenance-protocol
  - getting-started
---

# Doc Coverage & Freshness Map

One row per `docs/**/*.md`. Columns:

- **Doc** — path relative to `docs/`.
- **Subsystem** — the `subsystem` frontmatter slug.
- **source_paths** — count of code/doc files the doc declares it describes.
  This is what drives mechanical staleness detection: when any listed path
  changes in git after `verified_against`, the doc is flagged.
- **last_verified** — date the doc was last checked against the tree.
- **verified_against** — git short SHA the doc was checked against.

This table is **derived** from the frontmatter of every doc — it is not
hand-maintained truth, and the values below are read straight from each
doc's YAML block. The freshness *checker*,
`scripts/docs/check-doc-freshness.ts` (now on disk; run via
`pnpm docs:check` — see [`../reference/scripts.md`](../reference/scripts.md)
and the [maintenance protocol](../ai-agents/maintenance-protocol.md)),
reads each doc's `source_paths`, diffs them against git since
`verified_against`, and reports docs whose code has drifted. The checker
emits a freshness *ledger*, not this table; re-derive this file from the
frontmatter (e.g. `pnpm docs:check --json` plus a small formatter, or by
hand from the `---` blocks) rather than letting rows drift.

## Architecture

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| architecture/overview.md | cross-cutting | 13 | 2026-06-03 | 150cb15 |
| architecture/data-flow.md | cross-cutting | 9 | 2026-06-03 | 150cb15 |
| architecture/data-model.md | music-model | 10 | 2026-06-03 | 150cb15 |
| architecture/glossary.md | cross-cutting | 15 | 2026-06-03 | 150cb15 |

## Subsystems

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| subsystems/orchestrator.md | orchestrator | 16 | 2026-06-03 | 150cb15 |
| subsystems/providers-llm.md | providers-llm | 16 | 2026-06-03 | 150cb15 |
| subsystems/music-model.md | music-model | 16 | 2026-06-03 | 150cb15 |
| subsystems/edit-operations.md | edit-operations | 8 | 2026-06-03 | 150cb15 |
| subsystems/abc-rendering.md | abc-rendering | 9 | 2026-06-03 | 150cb15 |
| subsystems/editor-ui.md | editor-ui | 30 | 2026-06-03 | c717c3d |
| subsystems/command-palette.md | command-palette | 9 | 2026-06-03 | 150cb15 |
| subsystems/ghost-preview.md | ghost-preview | 12 | 2026-06-03 | 150cb15 |
| subsystems/chat-session.md | chat-session | 13 | 2026-06-03 | 150cb15 |
| subsystems/transport.md | transport | 13 | 2026-06-03 | 150cb15 |
| subsystems/import.md | import | 17 | 2026-06-03 | 150cb15 |
| subsystems/export.md | export | 5 | 2026-06-03 | 150cb15 |
| subsystems/persistence-db.md | persistence-db | 19 | 2026-06-03 | 150cb15 |
| subsystems/auth-gdpr.md | auth-gdpr | 16 | 2026-06-03 | e6f5a58 |
| subsystems/auth-data-lifecycle.md | auth | 6 | 2026-06-03 | e6f5a58 |
| subsystems/app-shell.md | app-shell | 23 | 2026-06-03 | 150cb15 |
| subsystems/evals-testing.md | evals-testing | 23 | 2026-06-03 | 150cb15 |

## Guides

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| guides/getting-started.md | cross-cutting | 8 | 2026-06-03 | 150cb15 |
| guides/development-workflow.md | cross-cutting | 6 | 2026-06-03 | 150cb15 |
| guides/adding-an-edit-operation.md | edit-operations | 10 | 2026-06-03 | 150cb15 |
| guides/adding-a-notation-feature.md | cross-cutting | 12 | 2026-06-03 | 150cb15 |
| guides/adding-a-provider.md | providers-llm | 13 | 2026-06-03 | 150cb15 |
| guides/durability-runbook.md | ops | 3 | 2026-06-03 | e6f5a58 |
| local-models.md | providers-llm | 3 | 2026-06-03 | 150cb15 |

## Reference

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| reference/api-routes.md | cross-cutting | 31 | 2026-06-03 | 150cb15 |
| reference/env-flags.md | cross-cutting | 29 | 2026-06-03 | e6f5a58 |
| reference/scripts.md | cross-cutting | 8 | 2026-06-03 | 150cb15 |

## Contributing

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| contributing/CONTRIBUTING.md | cross-cutting | 6 | 2026-06-03 | 150cb15 |

## AI agents

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| ai-agents/AGENT_GUIDE.md | cross-cutting | 10 | 2026-06-03 | 150cb15 |
| ai-agents/maintenance-protocol.md | cross-cutting | 6 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/orchestrator.md | orchestrator | 10 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/providers-llm.md | providers-llm | 14 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/music-model.md | music-model | 10 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/edit-operations.md | edit-operations | 8 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/abc-rendering.md | abc-rendering | 9 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/editor-ui.md | editor-ui | 34 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/command-palette.md | command-palette | 7 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/ghost-preview.md | ghost-preview | 12 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/chat-session.md | chat-session | 9 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/transport.md | transport | 13 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/import.md | import | 12 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/export.md | export | 4 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/persistence-db.md | persistence-db | 14 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/auth-gdpr.md | auth-gdpr | 18 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/app-shell.md | app-shell | 19 | 2026-06-03 | 150cb15 |
| ai-agents/context-cards/evals-testing.md | evals-testing | 14 | 2026-06-03 | 150cb15 |

## Meta

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| _meta/STYLE_GUIDE.md | cross-cutting | 5 | 2026-06-03 | 150cb15 |
| _meta/coverage.md | cross-cutting | 3 | 2026-06-03 | 150cb15 |
| README.md | cross-cutting | 6 | 2026-06-03 | 150cb15 |

## Testing

| Doc | Subsystem | source_paths | last_verified | verified_against |
| --- | --- | --- | --- | --- |
| testing/SMOKE_E2E_PLAN.md | evals-testing | 35 | 2026-06-03 | 150cb15 |

> Note: `docs/llms.txt` is intentionally omitted — it follows the plain
> llms.txt format and carries no frontmatter, so it has no `source_paths`
> to track (the checker walks only `*.md`, so it is never visited).
> `docs/local-models.md` has since been brought under the frontmatter
> contract (subsystem `providers-llm`, 3 source_paths) and is listed
> above. Per-doc `verified_against` SHAs vary: most docs sit at `150cb15`
> after the latest sweep, while a few independently-verified docs
> (`auth-gdpr`, `auth-data-lifecycle`, `durability-runbook`,
> `env-flags` at `e6f5a58`; `editor-ui` at `c717c3d`) carry their own
> baseline.

## See also

- [`STYLE_GUIDE.md`](STYLE_GUIDE.md) — the frontmatter contract these counts come from.
- [`../ai-agents/maintenance-protocol.md`](../ai-agents/maintenance-protocol.md) — how/when to regenerate this map.
- [`../reference/scripts.md`](../reference/scripts.md) — the freshness checker that audits this table.
