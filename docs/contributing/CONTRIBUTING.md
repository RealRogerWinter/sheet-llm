---
title: Contributing to sheet-llm
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 60d0bbe
source_paths:
  - package.json
  - drizzle.config.ts
  - tests/setup.ts
  - src/lib/auth/session.ts
  - src/lib/auth/recovery.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/env/flag.ts
related:
  - development-workflow
  - getting-started
  - maintenance-protocol
  - orchestrator
  - persistence-db
  - evals-testing
---

# Contributing to sheet-llm

This is the practical checklist for landing a change: how to get a tree
that builds, the branch/PR conventions the repo actually uses, the
checks every PR must pass locally, where to put tests, and the
docs-update step that is part of "done" here. It is intentionally terse
and points at the authoritative docs rather than restating them.

The single deepest reference for *how work lands* — milestone cadence,
the additive-edits invariant, flag-gated rollout — is
[`docs/guides/development-workflow.md`](../guides/development-workflow.md).
Read it once before your first non-trivial PR. This file is the
contributor-facing front door to it.

## 0. Prerequisites & setup

Toolchain is pinned. Use the exact versions so your runs match
everyone else's:

| Tool   | Version                  | Source of truth                          |
| ------ | ------------------------ | ---------------------------------------- |
| Node   | `>=20.9.0` (use 22)      | `package.json` `engines`                 |
| pnpm   | `9.15.9` (pinned)        | `package.json` `packageManager`          |

Full first-run setup — install, the two **required** boot secrets, DB
migration, `pnpm dev` — lives in
[`getting-started.md`](getting-started.md). The two things that bite
first-time runners:

- **`SESSION_SECRET` and `RECOVERY_SECRET` are required at boot and
  throw if missing or too short.** Both must be ≥32 bytes
  (`src/lib/auth/session.ts` and `src/lib/auth/recovery.ts` enforce the
  HS256 minimum). They must be **different** secrets.
- The SQLite DB is created by running migrations — `pnpm db:migrate`
  (`DATABASE_URL` defaults to `file:./data/sheet-llm.db`). See
  [`docs/subsystems/persistence-db.md`](../subsystems/persistence-db.md).

Without an `ANTHROPIC_API_KEY` the app still runs (stub LLM mode); you
just can't exercise real generation or the live/smoke evals.

> Heads-up for AI agents: this repo's Next.js (`16.2.6`) has breaking
> changes vs. older training data. Read the relevant guide under
> `node_modules/next/dist/docs/` before writing framework code — this is
> a standing rule in `AGENTS.md`.

## 1. Branch & PR conventions

These are derived from `git log`, not invented:

- **Never commit to `main`.** Branch first, open a PR against `main`,
  **squash-merge**. The squash subject becomes the line you
  see in `git log`.
- **One coherent step per PR.** Work is organized into milestones
  (`M<n>`) decomposed into small sequential PRs (`M<n>-PR-<k>`). M22
  (MusicXML export) shipped as 17 PRs, each adding one emit path. Prefer
  a narrow PR that passes every gate over a broad one.
- **Behavior changes ship dark first.** Gate any new behavior behind a
  default-off flag read through `isFlagEnabled(name, { defaultOn? })`
  (`src/lib/env/flag.ts`) — the one canonical server-side truthiness reader —
  then flip the default in a **separate** PR once it bakes. The flag stays as
  an operator escape hatch. See development-workflow §"Feature-flag
  rollout discipline".
- **OSS↔SaaS layering invariant.** Core / render / orchestrator code must
  impose no paywall and must not import `@/lib/billing` or `@/lib/auth` (use
  `@/lib/metering` / `@/lib/http`); **SaaS flags default OFF and fail closed**;
  **no secret reaches a client bundle**; the OSS edition runs uncapped. Full
  reference: [`docs/SAAS_BYOK_SEAMS.md`](../SAAS_BYOK_SEAMS.md).

### Commit message style

Conventional Commits, with this repo's milestone tag appended. The
squash subject pattern, straight from the log:

```
type(scope): summary (M<n>-PR-<k>) (#NNN)
```

| Element        | Convention                                                   | Example                                      |
| -------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Type           | `feat` / `fix` / `refactor` / `chore`                        | `fix(render): honor span.placement ...`      |
| Scope          | subsystem slug in parens                                      | `feat(editor):`, `feat(export):`, `feat(schema):` |
| Milestone tag  | `(M<n>-PR-<k>)` near the end; sub-steps get a letter         | `(M24-PR-3c)`, `(M22-PR-A)`                   |
| PR number      | `(#NNN)` appended by the squash-merge                        | `(#227)`                                      |
| Milestone-close| final PR notes completion                                    | `... (M20-PR-5, M20 complete) (#188)`        |

If an AI agent authored the work, **keep** the `Co-Authored-By:` commit
trailer and the generated-with footer in the PR body — they are part of
the audit trail.

## 2. The required checks

Run these locally before pushing a PR against `main`. Run them **in
order** and stop at the first failure. All eight should be green before
you open the PR:

| # | Gate                     | Command              | Needs API key? |
| - | ------------------------ | -------------------- | -------------- |
| 1 | Lint (**blocking**)      | `pnpm lint`          | no             |
| 2 | Build-graph boundary     | `pnpm lint:boundaries` | no           |
| 3 | Typecheck                | `pnpm typecheck`     | no             |
| 4 | **Schema drift**         | `pnpm db:generate` + git-status diff | no |
| 5 | abcjs Node spike         | `pnpm abcjs:spike`   | no             |
| 6 | Unit + integration tests | `pnpm test`          | no             |
| 7 | Smoke evals (4 cases)    | `pnpm eval:smoke`    | **yes** (~$0.01/run) |
| 8 | E2E tests                | `pnpm test:e2e`      | no¹            |

¹ The LLM-driven e2e specs (e.g. `drag-tagging.spec.ts`) auto-skip when
`ANTHROPIC_API_KEY` is unset; the import-driven regressions still run.

**The deterministic checks need no API key** — run them on every change:

```sh
pnpm lint && pnpm lint:boundaries && pnpm typecheck && pnpm test
```

A few check-specific things worth knowing:

- **Schema-drift (step 4)** is the one most likely to surprise you.
  Migrations in `drizzle/*.sql` are *generated* from
  `src/lib/db/schema.ts`, never hand-edited. If you touch the schema:
  `pnpm db:generate`, then commit **both** the schema and the new
  numbered `drizzle/NNNN_*.sql` (migrations are append-only — never edit
  a committed one). Forget this and your schema and committed migrations
  drift. Full detail: development-workflow §"The schema-drift guard".
- **Smoke evals (step 7)** call the real Anthropic API, so they need
  `ANTHROPIC_API_KEY` set — skip them without a key, and skip them for
  doc-only changes (the harness also recognizes a `[skip-live-eval]`
  marker; see `evals/README.md`).
- The live+visual suite and the `orchestrator_turns` retention trim are
  not part of the pre-push checks — run them manually as needed
  (`pnpm eval:live` / `pnpm eval:visual`; `pnpm trim:orchestrator-turns`).

The four-tier eval harness (mock / smoke / visual / live) and its
`pnpm eval:*` scripts are documented in
[`evals/README.md`](../../evals/README.md) and
[`docs/subsystems/evals-testing.md`](../subsystems/evals-testing.md).

## 3. Where to add tests

| Kind                     | Location                          | Runner / command                        |
| ------------------------ | --------------------------------- | --------------------------------------- |
| Unit (pure functions)    | colocated `src/**/*.test.ts`, or `tests/unit/` | `pnpm test` (vitest)        |
| Integration (API routes) | `tests/integration/*.test.ts`     | `pnpm test` (vitest)                    |
| End-to-end (browser)     | `tests/e2e/*.spec.ts`             | `pnpm test:e2e` (Playwright/Chromium)   |
| Eval cases (orchestrator)| `evals/**`                        | `pnpm eval:mock` / `eval:smoke` / `eval:live` |

`pnpm test` deliberately **excludes** the `eval/`, `evals/`, and
`tests/e2e/` trees (see the `--exclude` globs in `package.json`).

### The #1 new-contributor test footgun

`tests/setup.ts` forces `ORCHESTRATOR_ENABLED=false` for the whole
vitest run. The orchestrator is default-**on** in production, but tests
that don't explicitly opt in exercise the **legacy LLM path**. If your
test needs the orchestrator, override it in `beforeEach`:

```ts
vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
```

Forget this and your test silently runs the wrong code path. `setup.ts`
also forces `ORCHESTRATOR_LOG_SILENT=1`.

### Bug-fix testing pattern

When you fix a production "the AI did something weird" report, land the
**failing repro first**: a separate PR adding an `it.fails(...)` (or
`it.skip`) eval/test case that captures the exact failure mode, then a
fix-PR that turns it green. The forensic `orchestrator_turns` log plus
`pnpm replay -- --session <id>` reconstructs any historical decision
without re-running the LLM. See development-workflow §"Additive-edits
philosophy" and `evals/README.md`.

## 4. Update the docs you invalidate

Docs in `docs/` carry YAML frontmatter with `last_verified` and a
`source_paths` list of the code files each doc describes. That list is
what drives staleness detection. **When your change touches a file
listed in some doc's `source_paths`, update that doc in the same PR** and
bump its `last_verified` (and `verified_against` to the SHA you checked
against).

The exact protocol — how to find which docs reference your changed
files, what counts as a doc-invalidating change, the frontmatter
contract, and how staleness is detected — is in
[`maintenance-protocol.md`](maintenance-protocol.md). New docs must use
the frontmatter contract documented there. Treat a doc update as part of
"done," the same as a test.

## 5. Filing issues

Use GitHub issues for bugs and proposals. There is no issue-template
directory at this SHA, so write a plain issue and include:

- **Repro**: the exact prompt or action sequence, plus the score state
  if relevant. If it's an orchestrator/AI-behavior bug, include the
  session id — `pnpm replay -- --session <id>` reconstructs the decision
  trail from the `orchestrator_turns` log.
- **Expected vs. actual.**
- **Environment**: whether `ANTHROPIC_API_KEY` was set (stub vs. real
  LLM mode changes behavior), and any non-default flags from
  `src/lib/orchestrator/flags.ts`.

For AI-behavior regressions, the highest-value contribution is a failing
eval case (§3) — attach it to the issue or open it as the first PR.

## A typical PR, end to end

1. Branch off `main`; name the work `M<n>-PR-<k>` in your head.
2. Implement the smallest coherent slice. If it changes behavior, gate
   it behind a default-off `readBool` flag.
3. If you touched `src/lib/db/schema.ts`: `pnpm db:generate` and
   `git add drizzle/*.sql`.
4. If you touched a file in some doc's `source_paths`: update that doc
   and bump `last_verified` (§4).
5. Run the local gate trio: `pnpm lint && pnpm typecheck && pnpm test`.
6. Commit with a Conventional-Commit subject:
   `type(scope): summary (M<n>-PR-<k>)`. Keep agent trailers.
7. Run the remaining checks (`pnpm abcjs:spike`, and `pnpm eval:smoke`
   if you have an API key and it's not a doc-only change), then open the
   PR against `main`.
8. For a behavior flip, land a **separate** "flip default ON" PR after
   the dark PR has baked.

## See also

- [`docs/guides/development-workflow.md`](../guides/development-workflow.md) — the authoritative deep guide (milestone cadence, additive-edits invariant, flag rollout)
- [`getting-started.md`](getting-started.md) — first-run setup, secrets, `pnpm dev`
- [`maintenance-protocol.md`](maintenance-protocol.md) — the docs-update contract & staleness detection
- [`evals/README.md`](../../evals/README.md) — the four-tier eval harness + "first failing repro" pattern
- [`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md) — orchestrator design + full env-flag reference
- `package.json` — every `pnpm <script>` referenced above
- `tests/setup.ts` — test-run env defaults (orchestrator off by default)
