---
title: npm Scripts & the scripts/ Directory
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - package.json
  - scripts/replay.ts
  - scripts/backfill-orchestrator-turns.ts
  - scripts/trim-orchestrator-turns.ts
  - scripts/capture-visual-baselines.ts
  - scripts/abcjs-spike.mjs
  - scripts/docs/check-doc-freshness.ts
  - src/lib/db/observabilityRetention.ts
related:
  - persistence-db
  - orchestrator
  - evals-testing
  - abc-rendering
---

# npm Scripts & the `scripts/` Directory

Every runnable entry point in this repo. The first half is the full
`package.json` `scripts` table; the second half documents the five
standalone files under `scripts/` that those entries invoke.

The package manager is **pnpm 9.15.9** (`package.json:packageManager`).
`npm run <x>` works too, but examples below use `pnpm`. TypeScript
scripts run under [`tsx`](https://www.npmjs.com/package/tsx) (a dev
dependency); they are *not* compiled — `tsx scripts/foo.ts` executes
directly and resolves the `@/` path alias via the repo `tsconfig.json`.

> **Argument passing gotcha.** pnpm forwards everything after `--` to
> the script. So `pnpm replay -- --session abc` passes `--session abc`
> to `scripts/replay.ts`. Omitting the `--` makes pnpm try to interpret
> `--session` itself.

---

## package.json scripts

### Dev / build / quality

| Script | Command | What / when |
| --- | --- | --- |
| `dev` | `next dev` | Local dev server. **This is not stock Next.js** — see `AGENTS.md`; consult `node_modules/next/dist/docs/` before relying on framework behavior. |
| `build` | `next build` | Production build. |
| `start` | `next start` | Serve a prior `build`. |
| `lint` | `eslint` | Flat-config ESLint over the repo. |
| `typecheck` | `tsc --noEmit` | Type-check only; emits nothing. Run before pushing. |
| `format` | `prettier --write .` | Format the whole tree in place. |

### Test tiers

| Script | Command | What / when |
| --- | --- | --- |
| `test` | `vitest run` excluding `**/eval/**`, `**/evals/**`, `**/tests/e2e/**` | The unit/integration suite. The excludes keep eval and Playwright specs out of the default run. |
| `test:watch` | same as `test` in watch mode | Local iteration. |
| `test:e2e` | `playwright test` | Browser e2e suite under `tests/e2e/`. |
| `test:eval` | `vitest run -c vitest.eval.config.ts` | Legacy single eval config. Prefer the `eval:*` tiers below. |

### Eval tiers

Each maps to a dedicated vitest config. See `evals/README.md` for the
tier matrix (spend, determinism, when to run) and
[`../subsystems/orchestrator.md`](../subsystems/orchestrator.md) for what
the orchestrator contract being pinned is.

| Script | Command | Tier / spend |
| --- | --- | --- |
| `eval:mock` | `vitest run -c vitest.evals.config.ts` | Mock — zero API spend, fully deterministic. Runs every PR. |
| `eval:smoke` | `vitest run -c vitest.evals.smoke.config.ts` | Smoke — ~$0.001/run (a few Haiku classifier calls). Per-PR gate. |
| `eval:visual` | `vitest run -c vitest.evals.visual.config.ts` | Visual — zero spend; deterministic abcjs render + path-distance diff. Compares against the SVG baselines that `eval:baselines:capture` produces. |
| `eval:live` | `vitest run -c vitest.evals.live.config.ts` | Live — per-case real-provider spend. Run on demand; needs `ANTHROPIC_API_KEY` and `RUN_LIVE_EVALS`. |
| `eval:baselines:capture` | `tsx scripts/capture-visual-baselines.ts` | Regenerate the visual-eval baseline SVGs. See [below](#capture-visual-baselinests). |

### Database (Drizzle Kit)

These wrap `drizzle-kit` and operate against the SQLite file resolved
from `DATABASE_URL` (default `file:./data/sheet-llm.db`,
`src/lib/db/index.ts`). The application itself applies migrations at
boot via `ensureMigrationsApplied` (`src/instrumentation.ts`), so these
are mostly for authoring migrations and inspecting data.

| Script | Command | What / when |
| --- | --- | --- |
| `db:generate` | `drizzle-kit generate` | Generate a new SQL migration under `drizzle/` from a `schema.ts` change. After changing `schema.ts`, regenerate and commit the migration, or the schema and committed migrations drift. |
| `db:migrate` | `drizzle-kit migrate` | Apply pending migrations to the DB file. |
| `db:studio` | `drizzle-kit studio` | Launch Drizzle Studio (browser DB inspector). |

### Forensics / maintenance (orchestrator observability)

These drive the `orchestrator_turns` forensic log — see
[`../subsystems/persistence-db.md`](../subsystems/persistence-db.md) and
the [`scripts/` detail below](#scripts-directory).

| Script | Command | What / when |
| --- | --- | --- |
| `replay` | `tsx scripts/replay.ts` | Print a turn-by-turn ledger for one session. |
| `backfill:orchestrator-turns` | `tsx scripts/backfill-orchestrator-turns.ts` | Synthesize turn rows for pre-existing sessions (one-time). |
| `trim:orchestrator-turns` | `tsx scripts/trim-orchestrator-turns.ts` | Apply the 90-day retention TTL on demand. |

### Misc

| Script | Command | What / when |
| --- | --- | --- |
| `abcjs:spike` | `node scripts/abcjs-spike.mjs` | Phase-0 smoke check that `abcjs.parseOnly` runs under Node. Run after a Node upgrade. |

### Documentation

| Script | Command | What / when |
| --- | --- | --- |
| `docs:check` | `tsx scripts/docs/check-doc-freshness.ts` | Audit every `docs/**/*.md` for stale/broken/under-specified frontmatter. Add `--report-only` (never fails) or `--json`. Run it after editing code a doc's `source_paths` covers. See [`../ai-agents/maintenance-protocol.md`](../ai-agents/maintenance-protocol.md). |

---

## `scripts/` directory

Five top-level files (three TypeScript using `tsx`, the `@/` alias, and
the live DB layer; one TypeScript that bootstraps a jsdom shim; one plain
`.mjs`), plus a `docs/` subdirectory holding the freshness checker.

```
scripts/
├── replay.ts                      forensic per-session ledger     (pnpm replay)
├── backfill-orchestrator-turns.ts one-time historical turn fill   (pnpm backfill:orchestrator-turns)
├── trim-orchestrator-turns.ts     90-day retention TTL            (pnpm trim:orchestrator-turns)
├── capture-visual-baselines.ts    regenerate visual-eval SVGs     (pnpm eval:baselines:capture)
├── abcjs-spike.mjs                Node abcjs.parseOnly smoke test (pnpm abcjs:spike)
└── docs/
    └── check-doc-freshness.ts     doc frontmatter freshness audit (pnpm docs:check)
```

All three DB scripts call `ensureMigrationsApplied(getDb())` before any
query. This is load-bearing: on a fresh checkout the server boot path
(`src/instrumentation.ts`) hasn't run, so the `orchestrator_turns` table
won't exist yet and a bare select would crash with `no such table`. The
call is idempotent across processes.

### replay.ts

> `pnpm replay -- --session <session_id> [--unsafe-include-content]`

The forensic replay tool for a single orchestrator session. Reads
`orchestrator_turns`, `messages`, and `score_versions` for the session,
pairs each turn with its user prompt and assistant payload, and prints a
turn-by-turn ledger to stdout: handler, model, status, latency,
classification kind + confidence, score before→after (measure count, and
key/meter/title deltas), retained-event ratio, metadata-change flags,
applied-op count, and token usage.

Built for M3.5-PR-1 in response to the triplet-demo replacement bug,
where the offending session's classification + dispatch decision was
unrecoverable from stdout logs.

**Flags:**

| Flag | Default | Effect |
| --- | --- | --- |
| `--session <id>` | *required* | Session to replay. Empty if no turns recorded (try `backfill:orchestrator-turns` for legacy sessions). |
| `--unsafe-include-content` | off | **Opt-in to print raw user prompts and assistant payloads.** Off by default because content may contain copyrighted lyrics or PII; redacted output shows `[REDACTED — pass --unsafe-include-content to see]`. |
| `--help` / `-h` | — | Print usage and exit. |

**Non-obvious invariants this script encodes (footguns for anyone
touching the turns log):**

- `orchestrator_turns.created_at` is Unix epoch **milliseconds**, while
  `messages.created_at` and `score_versions.created_at` are
  **seconds**. The script upconverts seconds×1000 when pairing turns to
  messages. The ms resolution lets multiple turns in the same wall-second
  sort deterministically.
- Messages are ordered by `messages.seq` (a monotonic, unique-indexed
  canonical order), *not* by `created_at` — second-resolution timestamps
  paired same-second messages non-deterministically.
- Nullable change-flags (`keyChanged`/`meterChanged`/`titleChanged`)
  render as `?` when the diff was one-sided (e.g. a fresh generation with
  no prior score), which is semantically distinct from `no` (the field
  was present and preserved).
- Score versions referenced by any turn's before/after pointer are
  pre-fetched in a single `inArray` query and deduped via a `Map`, rather
  than 2N point queries inside the loop (PR-7 review fix).

### backfill-orchestrator-turns.ts

> `pnpm backfill:orchestrator-turns`

A **one-time** (idempotent) migration that synthesizes a best-effort
`orchestrator_turns` row per assistant message for sessions that existed
*before* the table was added in M3.5-PR-1 — so `replay` returns at least
a coarse decision trail for them. Inputs never recorded historically
(classification kind, dispatcher choice, latency) stay `null` /
`'unknown'`; `classificationKind` is set to the literal `'unknown'` so
backfilled rows are visually obvious in replay output.

Prints a one-line summary:
`backfill: scanned=N rows-inserted=M rows-skipped=K`.

**Idempotency / safety:**

- Every backfilled row is keyed to a message id; the script first builds
  a `Set` of message ids already covered by a live (`recordTurn`) or
  prior-backfill turn and skips them. Re-runs never double-count.
- Rows whose session was hard-deleted hit an FK violation
  (`sessions(id)` is `ON DELETE CASCADE`); the insert is caught and
  counted as `skipped`, never propagated. Backfill is best-effort.
- The `score_versions` lookup is bounded to the session ids that carry
  assistant messages (`inArray`), not a full-table slurp — an OOM guard
  on production-sized DBs.

The core logic is the exported pure function
`backfillOrchestratorTurns(db = getDb())`; the CLI `main()` only fires
when `process.argv[1]` resolves to this file, so unit tests can import
the function without triggering side effects.

### trim-orchestrator-turns.ts

> `pnpm trim:orchestrator-turns`

Applies the 90-day retention TTL to `orchestrator_turns` by calling the
pure helper `trimOrchestratorTurns(90, db)`
(`src/lib/db/observabilityRetention.ts:trimOrchestratorTurns`) and
printing `trim: orchestrator_turns deleted=<n>`.

Run on demand with `pnpm trim:orchestrator-turns` (90-day TTL on
`orchestrator_turns`). Idempotent across re-runs — the delete predicate
is `created_at < cutoff`, so the cutoff sweeps forward as wall-clock
advances and already-trimmed rows are gone after the first pass.

### capture-visual-baselines.ts

> `pnpm eval:baselines:capture`

Regenerates the visual-regression baseline SVGs from the pinned
`<name>.score.json` files under `evals/baselines/visual/`, writing each
to `<name>.baseline.svg`. These baselines are what `pnpm eval:visual`
diffs renders against.

Because `abcjs` reaches for `document` / `window`, the script first
bootstraps a **jsdom** shim onto `globalThis`, then installs the shared
`getBBox` polyfill via `installGetBBoxPolyfillOn`
(`evals/lib/jsdomShim.ts`) — *the same* polyfill `tests/setup.ts` uses,
so the two callers can't drift (a stale polyfill would silently
invalidate visual evals). It dynamically imports `renderScoreSvg`
(`evals/lib/renderScoreSvg.ts`) only *after* the shim is in place.

**When:** after any renderer change that legitimately alters output
(see [`../subsystems/abc-rendering.md`](../subsystems/abc-rendering.md)).
The regenerated SVGs **must be eyeballed** (does the notation still look
musically right?) and committed alongside the change that motivated
them. No flags.

### abcjs-spike.mjs

> `pnpm abcjs:spike`

A Phase-0 spike (plain ESM, no `tsx`) that verifies `abcjs.parseOnly`
works server-side under Node — the MVP relies on this for server-side
ABC validation. Parses a one-line fixture, asserts a non-empty tune
array, and prints the Node version plus any parser warnings. **Run it
after a Node upgrade**; if it breaks, the file's header notes the
fallback (a syntactic-only check or a sub-path import that avoids browser
globals). No flags.

### docs/check-doc-freshness.ts

> `pnpm docs:check [--report-only] [--json]`

The documentation self-maintenance tool. Globs every `docs/**/*.md`,
parses each file's YAML frontmatter, and reports three classes of
problem:

- **STALE** — a `source_paths` entry has commits in the range
  `verified_against..HEAD` (the code moved on but the doc wasn't
  re-verified). Detected via `git log --oneline <sha>..HEAD -- <path>`.
- **BROKEN** — a `source_paths` entry points at a file that no longer
  exists (rename/delete).
- **MISSING FRONTMATTER** — a doc lacks `source_paths`, `last_verified`,
  or `verified_against`.

Exit code is non-zero when any problem is found, **unless**
`--report-only` is passed (which always exits 0, so a stale doc informs
without blocking). `--json` emits a machine-readable report. Frontmatter is parsed by a tiny hand-rolled
reader (the doc frontmatter is a fixed, tiny shape, so no YAML dependency
is pulled). CRLF checkouts are normalized, so it runs on Windows.

This is the enforcement arm of the freshness contract documented in
[`../ai-agents/maintenance-protocol.md`](../ai-agents/maintenance-protocol.md)
and [`../_meta/STYLE_GUIDE.md`](../_meta/STYLE_GUIDE.md). Run it after
editing code a doc's `source_paths` covers. It needs full git history
(the `verified_against` SHA must be reachable for the range diff), so run
it against a complete checkout rather than a shallow clone.

---

## See also

- `package.json` — the canonical script table this doc mirrors.
- `evals/README.md` — the eval tier matrix the `eval:*` scripts target.
- [`../subsystems/persistence-db.md`](../subsystems/persistence-db.md) —
  the `orchestrator_turns` / `score_versions` / `messages` schema the
  forensic scripts read.
- [`../subsystems/orchestrator.md`](../subsystems/orchestrator.md) —
  what a "turn" is and where `recordTurn` writes from.
- `src/lib/db/observabilityRetention.ts` — `trimOrchestratorTurns`, the
  pure helper behind `trim:orchestrator-turns`.
