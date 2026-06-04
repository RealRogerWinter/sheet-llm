---
title: Getting Started — Contributor Onboarding
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - package.json
  - .env.example
  - drizzle.config.ts
  - src/lib/db/index.ts
  - src/instrumentation.ts
  - src/lib/auth/session.ts
  - src/lib/auth/recovery.ts
  - src/lib/llm/index.ts
related:
  - orchestrator
  - persistence-db
  - auth-gdpr
  - providers-llm
  - evals-testing
---

# Getting Started

Zero-to-running for a new sheet-llm contributor: install, configure env,
boot the dev server, set up the database, run the tests, and find your
first contribution. Every command here is pulled from
[`package.json`](../../package.json) `scripts` and verified at the SHA in
the frontmatter — if a command below isn't in that scripts block, treat
this doc as stale and fix it.

> Read this NOT-the-Next.js-you-know warning first: this repo pins
> **Next.js 16** (`next@16.2.6`) and **React 19**. APIs and conventions
> differ from older Next. See the root [`AGENTS.md`](../../AGENTS.md) —
> the canonical Next docs are vendored under
> `node_modules/next/dist/docs/`; read the relevant guide before writing
> framework code.

## Prerequisites

| Tool   | Required version          | Enforced by                                  |
| ------ | ------------------------- | -------------------------------------------- |
| Node   | `>=20.9.0`                | `engines.node` in `package.json`             |
| pnpm   | `9.15.9`                  | `packageManager` in `package.json`           |

The repo declares its package manager via Corepack-style
`packageManager: "pnpm@9.15.9"`. Enable Corepack (`corepack enable`) or
install that exact pnpm so lockfile resolution is reproducible. All
scripts below assume `pnpm`; the eval/README docs sometimes write
`npm run …` — the script names are identical, only the runner differs.

## 1. Install

```sh
pnpm install
```

This installs `better-sqlite3` (a native addon) — you need a working C++
toolchain for the postinstall build (Xcode CLT on macOS, build-essential
on Linux, the VS Build Tools on Windows). If install fails on
`better-sqlite3`, that toolchain is the usual cause.

## 2. Environment variables

Copy the template and fill it in:

```sh
cp .env.example .env.local
```

`.env.local` is the file Next loads for local dev. The full template is
[`.env.example`](../../.env.example). The variables that matter to get a
working local server:

| Var                   | Required? | Default if unset                | Effect / why                                                                                                                                                  |
| --------------------- | --------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`      | **Yes**   | throws                          | HS256 signing key for the anon session JWT. `src/lib/auth/session.ts:getSecret` throws if missing or `<32` bytes (RFC 7518 §3.2).                              |
| `RECOVERY_SECRET`     | **Yes**   | throws                          | Separate HS256 key for the localStorage recovery token. `src/lib/auth/recovery.ts:getRecoverySecret` throws if missing. **MUST differ from `SESSION_SECRET`.** |
| `SL_INSECURE_COOKIE_OK`| Local only | unset → cookies are `Secure`   | Set to `1` for localhost over plain HTTP. `session.ts` sets `secure: process.env.SL_INSECURE_COOKIE_OK !== '1'`. Never set this anywhere network-reachable.    |
| `ANTHROPIC_API_KEY`   | No        | unset → LLM **stub mode**       | When unset, `src/lib/llm/index.ts:getLLMClient` returns the in-memory `stubClient` (canned responses); the provider path's `anthropic.ts` throws if it's hit. Set it to talk to the real model. |
| `DATABASE_URL`        | No        | `file:./data/sheet-llm.db`      | SQLite file path. Only `file:*` URLs are supported (`src/lib/db/index.ts:resolveDbPath` throws otherwise). The dir is `mkdir -p`'d on first open.              |

Generate each secret with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Run it twice — `SESSION_SECRET` and `RECOVERY_SECRET` must be different
key material so they can be rotated independently (an XSS that steals the
JS-exposed recovery token must not also be a session-cookie forgery
oracle; see [`src/lib/auth/recovery.ts`](../../src/lib/auth/recovery.ts)
header comment and the [auth-gdpr context card](../ai-agents/context-cards/auth-gdpr.md)).

A minimal `.env.local` for local HTTP dev:

```sh
ANTHROPIC_API_KEY=sk-ant-...        # optional; omit to run in stub mode
SESSION_SECRET=<base64-32-bytes>
RECOVERY_SECRET=<different-base64-32-bytes>
SL_INSECURE_COOKIE_OK=1
# DATABASE_URL defaults to file:./data/sheet-llm.db — no need to set it.
```

For the **full** set of orchestrator and provider runtime flags
(`SL_NEW_TOOL_DISPATCH`, `SL_REPLACEMENT_GATE`, `SL_GHOST_PREVIEW`,
`ORCHESTRATOR_*`, `PROVIDER_*`, deadlines, budgets …) and their defaults,
see the dedicated **env-flags reference** (`../reference/env-flags.md`)
and the in-repo [`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md)
flag table. None of those flags are required for a first boot — every one
has a sane default-on/default-off baked in.

> Stub mode is the fast path for UI/editor work: no key, no spend, no
> network. You only need a real `ANTHROPIC_API_KEY` when you're working
> on the orchestrator/LLM path or running the smoke/live eval tiers.

## 3. Database setup

The DB is SQLite via `better-sqlite3` + Drizzle. You do **not** normally
run a migrate step by hand for local dev:
[`src/instrumentation.ts`](../../src/instrumentation.ts) calls
`ensureMigrationsApplied()` (from `src/lib/db/index.ts`) once on server
boot, applying every pending migration in `drizzle/` before any route
handler runs. So `pnpm dev` self-migrates on first request.

**Where the file lives:** `./data/sheet-llm.db` (relative to repo root),
unless you override `DATABASE_URL`. The parent dir is created
automatically (`src/lib/db/index.ts:openDb` → `fs.mkdirSync(..., { recursive: true })`),
and the connection opens in WAL mode, so you'll also see
`sheet-llm.db-wal` / `-shm` sidecars. The `data/` directory is gitignored
local state — safe to delete to reset; it'll be recreated and
re-migrated on next boot.

You'll use the Drizzle CLI scripts directly only when **changing the
schema** ([`src/lib/db/schema.ts`](../../src/lib/db/schema.ts)):

| Script             | Command              | What it does                                                            |
| ------------------ | -------------------- | ---------------------------------------------------------------------- |
| `db:generate`      | `pnpm db:generate`   | `drizzle-kit generate` — diff schema.ts → emit a new SQL migration in `drizzle/`. |
| `db:migrate`       | `pnpm db:migrate`    | `drizzle-kit migrate` — apply pending migrations (the manual equivalent of boot-time auto-migrate). |
| `db:studio`        | `pnpm db:studio`     | `drizzle-kit studio` — browse the SQLite DB in a local web UI.         |

Config is [`drizzle.config.ts`](../../drizzle.config.ts) (dialect
`sqlite`, schema `./src/lib/db/schema.ts`, out `./drizzle`). Guard against
schema drift between `schema.ts` and the checked-in migrations yourself —
if you edit the schema, run `pnpm db:generate`, commit the new SQL
file, and confirm `git status` shows no unexpected `drizzle/*.sql`
changes. For the persistence model (versioned Score checkpoints, head
pointers, CAS writes) see the
[persistence-db context card](../ai-agents/context-cards/persistence-db.md).

## 4. Run the dev server

```sh
pnpm dev
```

Open <http://localhost:3000>. The app is a single-page editor at `/`
(plus a GDPR `/settings` page). On first load the session layer mints an
anonymous user + cookie (`src/lib/auth/session.ts:getOrCreateUserId`), so
no login step exists. If the page errors immediately on a missing
`SESSION_SECRET`/`RECOVERY_SECRET`, re-check step 2 — those throw at
request time, not silently.

Type a prompt in the prompt bar to drive the LLM orchestrator. In stub
mode you'll get canned compositions; with a real key the
`/api/chat` orchestrator runs the full copyright-filter → tool-dispatch →
preservation-verify → replacement-gate → ghost-preview pipeline (see the
[orchestrator README](../../src/lib/orchestrator/README.md)).

## 5. Run the tests

```sh
pnpm test          # vitest run, excludes eval/** and tests/e2e/**
pnpm test:watch    # same scope, watch mode
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm format        # prettier --write .
```

`pnpm test` is the unit + integration suite (vitest), with `**/eval/**`,
`**/evals/**`, and `**/tests/e2e/**` excluded by the script's `--exclude`
globs. End-to-end browser tests are separate:

```sh
pnpm test:e2e      # playwright test
```

### Eval tiers

The orchestrator's contract behavior is pinned by a four-tier eval
harness, each tier with its own vitest config and its own gating env var.
Full detail (cases, cost) lives in
[`evals/README.md`](../../evals/README.md); the script surface:

| Tier   | Command            | Config                          | Spend     | Gating env             |
| ------ | ------------------ | ------------------------------- | --------- | ---------------------- |
| Mock   | `pnpm eval:mock`   | `vitest.evals.config.ts`        | $0        | none (default)         |
| Smoke  | `pnpm eval:smoke`  | `vitest.evals.smoke.config.ts`  | ~$0.005   | `RUN_SMOKE_EVALS=1` + `ANTHROPIC_API_KEY` |
| Visual | `pnpm eval:visual` | `vitest.evals.visual.config.ts` | $0        | none (deterministic render) |
| Live   | `pnpm eval:live`   | `vitest.evals.live.config.ts`   | per-case  | `RUN_LIVE_EVALS=1` + `ANTHROPIC_API_KEY` |

Mock and visual are zero-cost and need no key — run those freely. Smoke
and live hit the real Anthropic API and are skipped unless their
`RUN_*` env var is set:

```sh
# zero-cost, no key:
pnpm eval:mock
pnpm eval:visual

# real classifier, ~$0.005:
RUN_SMOKE_EVALS=1 ANTHROPIC_API_KEY=sk-... pnpm eval:smoke

# full live suite, per-case spend:
RUN_LIVE_EVALS=1 ANTHROPIC_API_KEY=sk-... pnpm eval:live
```

(There is also `pnpm test:eval` → `vitest run -c vitest.eval.config.ts`,
a separate legacy eval config; the four tiers above are the maintained
harness.) Visual baselines are regenerated with
`pnpm eval:baselines:capture` after a deliberate renderer change — see
the visual-regression section of `evals/README.md`.

## 6. Build / production sanity

```sh
pnpm build         # next build
pnpm start         # next start (serves the build)
```

You won't need these day-to-day, but `pnpm build` is the quickest way to
catch a type or RSC error the dev server tolerates.

## First-contribution orientation

1. **Understand the spine.** The whole app revolves around the `Score`
   data model — a deeply-nested Zod schema in
   [`src/lib/music/types.ts`](../../src/lib/music/types.ts). Read
   `ScoreSchema` + `Event`/`Measure`/`Pitch` first. The
   [music-model context card](../ai-agents/context-cards/music-model.md)
   is the guided tour.

2. **Trace the core flow.** user prompt → `/api/chat` → orchestrator
   (copyright filter → tool-use dispatch → handler → preservation verify
   → replacement gate → ghost-preview proposal) → Score persisted as a
   versioned row → Score→ABC (with SourceMap) → abcjs render. The
   authoritative deep reference is
   [`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md)
   — it is the BAR for doc tone in this repo.

3. **Pick a subsystem.** Each has a context card under
   [`docs/ai-agents/context-cards/`](../ai-agents/context-cards/) and a
   companion survey under [`docs/subsystems/`](../subsystems/):
   `music-model`, `abc-rendering`, `edit-operations`, `orchestrator`,
   `providers-llm`, `import`, `export`, `persistence-db`, `auth-gdpr`,
   `chat-session`, `editor-ui`, `command-palette`, `transport`,
   `ghost-preview`.

4. **If you're an AI agent**, start from the context cards in
   [`docs/ai-agents/`](../ai-agents/) — they're written for you (entry
   files, key paths, flags) — then the matching subsystem survey. Every
   card's frontmatter `source_paths` is the ground truth for what code it
   describes; verify a claim against the file before relying on it.

5. **Match the bar.** New code: read the relevant Next 16 guide under
   `node_modules/next/dist/docs/` before writing framework code; new
   docs: follow the frontmatter + writing-style contract this repo uses
   (precise, technical, real clickable paths, document the WHY and the
   gotchas).

6. **When fixing a bug**, land the failing repro first. The eval harness
   has a "first failing repro" convention (`it.fails(...)` then flip to
   green in the fix PR) — see `evals/README.md`. For local-model /
   offline workflows, see [`docs/local-models.md`](../local-models.md).

## See also

- [`package.json`](../../package.json) — the authoritative script list.
- [`.env.example`](../../.env.example) — the env template.
- [`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md) — orchestrator deep reference + flag table.
- [`evals/README.md`](../../evals/README.md) — eval tiers, cases.
- [`docs/local-models.md`](../local-models.md) — running against a local Ollama LLM.
- Subsystem context cards: [`docs/ai-agents/context-cards/`](../ai-agents/context-cards/).
- Subsystem surveys: [`docs/subsystems/`](../subsystems/).
