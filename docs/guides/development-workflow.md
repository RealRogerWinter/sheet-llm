---
title: Development Workflow
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - package.json
  - drizzle.config.ts
  - src/lib/orchestrator/flags.ts
  - src/lib/orchestrator/README.md
  - evals/README.md
  - tests/setup.ts
related:
  - orchestrator
  - ghost-preview
  - persistence-db
  - evals-testing
---

# Development Workflow

How work actually lands in this repo: small sequenced PRs under a
milestone, a set of pre-push checks contributors run locally, a
schema-drift step that catches a forgotten migration regeneration, and
two cross-cutting disciplines the codebase enforces structurally —
**additive edits** (never silently overwrite user work) and
**flag-gated rollout** (every behavior change ships dark, then a
separate PR flips the default).

This guide is derived from `package.json`, `drizzle.config.ts`,
`src/lib/orchestrator/flags.ts`, and the git log. Every command and flag
below was verified against the files at SHA `150cb15`.

## Milestone / PR cadence

Work is organized into **milestones** (`M<n>`) that each decompose into
a sequence of **small, individually-reviewable PRs** (`M<n>-PR-<k>`).
The commit subject encodes both, e.g. from `git log`:

```
feat(orchestrator): flip SL_GHOST_PREVIEW default ON (M24-PR-6) (#227)
feat(editor): manual-edit pauses AI + 30s resume toast (M24-PR-5) (#226)
feat(editor): docked diff panel for ghost preview >=5 events (M24-PR-4) (#225)
feat(editor): inline ghost preview overlay (amber recolor + accept/reject) (M24-PR-3c) (#224)
```

Conventions visible in the log:

| Element            | Convention                                                              | Example                                          |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Type prefix        | Conventional Commits: `feat` / `fix` / `refactor` / `chore`             | `fix(render): honor span.placement ...`          |
| Scope              | subsystem slug in parens                                                 | `feat(editor):`, `feat(export):`, `feat(schema):`|
| Milestone+PR tag   | `(M<n>-PR-<k>)` near the end of the subject; sub-steps get a letter      | `(M24-PR-3c)`, `(M22-PR-A)`                       |
| PR number          | `(#NNN)` appended by the squash-merge                                    | `(#227)`                                          |
| Milestone-close    | the final PR notes completion in the subject                            | `... (M20-PR-5, M20 complete) (#188)`            |

Each PR is **one coherent step**. A milestone like M22 (MusicXML
export) shipped as 17 PRs (`PR-1..5` then `PR-A..L`), each adding one
emit path (ties, voltas, tuplets, dynamics, ...). Prefer landing a
narrow PR that passes all gates over a broad one that touches many
subsystems.

> **Branching**: PRs target `main`. Never commit directly to `main`;
> branch first, open a PR, squash-merge. The squash subject
> becomes the line you see in `git log`.

> **AI-agent attribution**: commit messages authored by an agent end
> with the `Co-Authored-By:` trailer; PR bodies carry the generated-with
> footer. Keep these — they are part of the audit trail.

## Pre-push checks

Run these checks locally before pushing. Use pnpm `9.15.9` (pinned;
`package.json` declares `packageManager: "pnpm@9.15.9"`) on Node 22. The
recommended order matches the order of dependence — run them top to
bottom and stop at the first failure:

| # | Step                       | Command                              | What it catches                                            |
|---|----------------------------|--------------------------------------|------------------------------------------------------------|
| 1 | Lint                       | `pnpm lint` (`eslint`)               | style / lint-rule violations                               |
| 2 | Typecheck                  | `pnpm typecheck` (`tsc --noEmit`)    | type errors (no emit — pure check)                         |
| 3 | **Schema drift**           | `pnpm db:generate` + git-status diff | edited `schema.ts` without committing the migration        |
| 4 | abcjs Node spike           | `pnpm abcjs:spike`                   | abcjs failing to load/run under Node (render-engine smoke) |
| 5 | Unit + integration tests   | `pnpm test`                          | vitest unit + integration suites                           |
| 6 | Smoke evals (4 cases)      | `pnpm eval:smoke`                    | orchestrator dispatch contract, ~$0.01/run                 |
| 7 | E2E tests                  | `pnpm test:e2e` (Playwright/Chromium)| full-stack browser regressions                             |

The deterministic checks need no API key — run them on every change:

```sh
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` excludes the eval and e2e trees (see `package.json` —
`vitest run --exclude "**/eval/**" --exclude "**/evals/**" --exclude
"**/tests/e2e/**"`). The two flaky pre-existing tests
(`tests/integration/api-chat-fork.test.ts` and a midiToScore octave
case) are documented in `evals/README.md` under "Known-failing-tests
policy"; they are excluded from eval runs, not from `pnpm test`.

### Test environment defaults (gotcha)

`tests/setup.ts` forces two env vars for the whole vitest run:

- `ORCHESTRATOR_LOG_SILENT=1` — silences orchestrator structured logs.
- `ORCHESTRATOR_ENABLED=false` — the orchestrator defaults **on** in
  production (`src/lib/orchestrator/flags.ts:getOrchestratorMode`), but
  tests that don't explicitly opt in exercise the **legacy path**.
  Orchestrator-specific tests override with
  `vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')` in their `beforeEach`.

If you write a test that expects the orchestrator and forget the
stub, you'll silently exercise the legacy LLM path instead. This is
the most common new-contributor footgun.

### Smoke evals (step 6) and the live-eval bypass

`pnpm eval:smoke` calls the real Anthropic API (~$0.01/run: 3 Haiku
classifier probes + 1 Sonnet dispatcher probe), so it needs
`ANTHROPIC_API_KEY` set — without a key it short-circuits. Skip it for
doc-only changes; the harness also recognizes a `[skip-live-eval]`
marker (see `evals/README.md` → "`[skip-live-eval]` bypass").

The four-tier eval harness (mock / smoke / visual / live) is documented
in [`evals/README.md`](../../evals/README.md). The live+visual suite and
the `orchestrator_turns` retention trim are not part of the pre-push
checks — run them manually as needed (`pnpm eval:live` /
`pnpm eval:visual`; `pnpm trim:orchestrator-turns`).

## The schema-drift guard (step 3)

This is the gate most likely to surprise you. SQLite migrations live in
`drizzle/*.sql` and are **generated** from the Drizzle schema, not
hand-written. The source of truth is `src/lib/db/schema.ts`
(`drizzle.config.ts` → `schema: './src/lib/db/schema.ts'`, `out:
'./drizzle'`).

Regenerate migrations before pushing and confirm the working tree is
clean — if `drizzle/*.sql` changes, you forgot to commit a migration:

```sh
pnpm db:generate
git status --porcelain -- 'drizzle/*.sql'   # any output => schema drift; commit the new drizzle/*.sql
```

**The workflow when you touch the DB schema:**

```sh
# 1. Edit the Drizzle schema
$EDITOR src/lib/db/schema.ts

# 2. Regenerate the migration SQL
pnpm db:generate          # drizzle-kit generate -> new drizzle/NNNN_*.sql

# 3. Commit BOTH the schema change and the generated migration
git add src/lib/db/schema.ts drizzle/*.sql
```

Forget step 2/3 and your schema and committed migrations drift.

**Why the check is scoped to `drizzle/*.sql` only** (not all of
`drizzle/`): `drizzle/meta/_journal.json` carries a `when` timestamp and
`_snapshot.json` gets whitespace-reformatted across drizzle-kit minor
bumps — neither is real schema drift, so ignore `drizzle/meta/`
deliberately. Existing migrations
at this SHA: `drizzle/0000_*.sql` .. `drizzle/0006_accounts.sql`.
Migrations are append-only — a new schema change always produces a new
numbered file; never edit a committed migration. The orchestrator's
`orchestrator_turns` observability table, for example, arrived as
`drizzle/0004_orchestrator_turns.sql`. See
[`docs/subsystems/persistence-db.md`](../subsystems/persistence-db.md)
for the runtime migration apply path.

## Additive-edits philosophy

The single most important behavioral invariant in this codebase: **AI
edits must never silently replace user work.** This is not a style
preference — it is enforced by three independent server-side layers in
the orchestrator, all default-on. The triplet-demo "add 4 more bars →
wholesale rewrite" incident (M3.5) is the regression these layers exist
to prevent.

| Layer                       | File                                          | What it guarantees                                                                                   |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Preservation verification   | `src/lib/orchestrator/preservationVerifier.ts`| Re-hashes the measures a tool was supposed to leave untouched; refuses the result if any hash drifts. The LLM is never trusted to self-report preservation. |
| Replacement-confirmation gate | `src/lib/orchestrator/replacementDetect.ts` | Fires when >½ of input measures are no longer byte-identical AND key/meter/title changed AND the prompt lacks explicit rewrite intent; sets `requiresConfirmation`. |
| AI ghost preview (M24)      | `src/lib/orchestrator/index.ts:maybeAttachGhostProposal` | Turns every score-mutating turn into a previewed proposal the user accepts/rejects, instead of a silent commit. |

When you add or change a score-producing handler, you inherit these
guarantees for free — but you must respect them: a handler that
re-emits a retained measure with any mutation will be rejected by the
verifier (it falls through to the legacy path so the user still gets a
response). Full design, the gate's exact firing predicate, and the
"first failing repro" testing pattern are in
[`src/lib/orchestrator/README.md`](../../src/lib/orchestrator/README.md)
and the subsystem docs
[`docs/subsystems/orchestrator.md`](../subsystems/orchestrator.md) /
[`docs/subsystems/ghost-preview.md`](../subsystems/ghost-preview.md).

**When you hit a production "the AI did something weird" report**, the
first PR should land a *failing eval case* (`it.fails(...)`) that
captures the exact failure mode; the fix-PR turns it green. See
`evals/README.md` → "The 'first failing repro' pattern". The forensic
`orchestrator_turns` log + `pnpm replay -- --session <id>` reconstructs
any historical decision trail without re-running the LLM.

## Feature-flag rollout discipline

Every behavior change ships **dark first**, then a **separate PR flips
the default**. The mechanism is encoded directly in
`src/lib/orchestrator/flags.ts`, which has exactly two helpers:

```ts
// default-OFF: flag must be explicitly turned on
function readBool(name)         { ... return v === '1' || v === 'true' }
// default-ON:  flag is on unless explicitly turned off
function readExplicitFalse(name){ ... return v === '0' || v === 'false' }
```

A new feature is introduced behind a `readBool` gate (default-off), so
merging the implementation PR ships zero behavior change. Once it bakes,
a one-line "flip default ON" PR swaps the accessor to
`!readExplicitFalse(...)` — the flag stays as an operator **escape
hatch** (`=0` rolls back without redeploy) but the default behavior
changes. The M24 ghost-preview rollout is the canonical example:

```
feat(orchestrator): ghost-preview proposal hook behind SL_GHOST_PREVIEW (M24-PR-2) (#221)   <- dark, default-off
...
feat(orchestrator): flip SL_GHOST_PREVIEW default ON (M24-PR-6) (#227)                       <- flip
```

After the flip, `isGhostPreviewEnabled()` reads
`!readExplicitFalse('SL_GHOST_PREVIEW')` — on unless someone sets
`SL_GHOST_PREVIEW=0`.

Current orchestrator flag defaults (verified in `flags.ts`):

| Flag                        | Accessor                          | Default | Roll back with                       |
| --------------------------- | --------------------------------- | ------- | ------------------------------------ |
| `SL_NEW_TOOL_DISPATCH`      | `!readExplicitFalse`              | **on**  | `=0` → legacy Haiku classifier path  |
| `SL_REPLACEMENT_GATE`       | `!readExplicitFalse`              | **on**  | `=0` → silent-replace (pre-gate)     |
| `SL_GHOST_PREVIEW`          | `!readExplicitFalse`              | **on**  | `=0` → silent commit                 |
| `SL_SECTIONAL_GEN`          | `!readExplicitFalse`              | **on**  | `=0` → single-shot runGenerateComplex |
| `SL_BOUNDED_GEN`            | `!readExplicitFalse`              | **on**  | `=0` → free-tier reverts to legacy/sectional gen (paywall stays closed) |
| `SL_STREAM_ABORT`           | `readBool`                        | off     | `=1` → enables the converse/text mid-stream output-token+wall-clock cutoff |
| `SL_COMPOSE_PATCH_DISPATCH` | `readBool`                        | off     | deprecated; ignored when dispatch on |
| `ORCHESTRATOR_KILL`         | `readBool`                        | off     | `=1` → orchestrator returns null      |
| `ORCHESTRATOR_ENABLED`      | `readExplicitFalse` (opt-out)     | on      | `=false`/`0` → route falls through    |
| `ORCHESTRATOR_MODE`         | string compare                    | primary | `=shadow` → legacy wins, divergence logged |

**Invariant**: every flag in `flags.ts` is read fresh on every call —
there is **no module-load caching**. Operators flip flags without a
redeploy and the next request honors the new value. Do not cache a flag
read at module scope; you would break the rollback contract. The full
reference (precedence ordering, shadow mode, kill switch) lives in the
[orchestrator README env-flag table](../../src/lib/orchestrator/README.md#env-flag-reference).

## Putting it together: a typical PR

1. Branch off `main`; name the work `M<n>-PR-<k>` in your head (and in
   the eventual commit subject).
2. Implement the smallest coherent slice. If it changes behavior, gate
   it behind a default-off `readBool` flag.
3. If you touched `src/lib/db/schema.ts`, run `pnpm db:generate` and
   `git add drizzle/*.sql`.
4. Run the local gate trio: `pnpm lint && pnpm typecheck && pnpm test`.
5. Conventional-commit subject:
   `type(scope): summary (M<n>-PR-<k>)`. Keep the `Co-Authored-By`
   trailer if an agent wrote it.
6. Run the remaining pre-push checks (`pnpm abcjs:spike`, and
   `pnpm eval:smoke` if you have an API key and it's not a doc-only
   change), then open the PR against `main`.
7. For a behavior flip, land a **separate** "flip default ON" PR after
   the dark PR has baked and (ideally) an eval case pins the behavior.

## See also

- `package.json` — every `pnpm <script>` referenced above
- `drizzle.config.ts` — schema source + migration output paths
- `src/lib/orchestrator/flags.ts` — the default-off vs default-on accessor pattern
- `src/lib/orchestrator/README.md` — additive-edits design + full flag reference
- `evals/README.md` — the four-tier eval harness + "first failing repro" pattern
- `tests/setup.ts` — test-run env defaults (orchestrator off by default)
- [`docs/subsystems/orchestrator.md`](../subsystems/orchestrator.md)
- [`docs/subsystems/ghost-preview.md`](../subsystems/ghost-preview.md)
- [`docs/subsystems/persistence-db.md`](../subsystems/persistence-db.md)
