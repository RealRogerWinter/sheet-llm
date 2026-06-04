---
title: Documentation Style Guide
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - docs/architecture/overview.md
  - docs/subsystems/orchestrator.md
  - docs/ai-agents/context-cards/orchestrator.md
  - docs/guides/getting-started.md
  - src/lib/orchestrator/README.md
related:
  - overview
  - orchestrator
---

# Documentation Style Guide

This file is the **canonical contract** for every doc under `docs/`. If you are
about to write or edit a doc — human or AI agent — read this first and follow it
exactly. The reference implementation of the target tone and depth is
`src/lib/orchestrator/README.md`; when in doubt, open it and match it.

The guide has one job: keep `docs/` **dense, technical, and verifiably true**. A
doc that paraphrases code without pointing at it, or that states a fact nobody
checked against the tree, is worse than no doc — it rots silently and misleads.
Every rule below exists to prevent that.

## The cardinal rule: every factual claim is verified against code

> **Do not write a path, export name, type, flag default, or behavioral claim
> you have not seen on disk at the current commit.**

This is non-negotiable and overrides every convenience.

- Open the file with Read/Grep/Glob **before** you name a symbol, path, flag, or
  default. Never infer an export from a filename. Never reconstruct an API from
  memory or from how "this kind of project usually works."
- If you cannot verify a claim, **omit it** or mark it explicitly as unverified
  (`<!-- UNVERIFIED: ... -->`). A gap is recoverable; a confident falsehood is not.
- Flag **defaults** are facts. Read the accessor (e.g.
  `src/lib/orchestrator/flags.ts`) and report what the code actually defaults to,
  not what the env var "should" be.
- When a behavior depends on a flag, state the flag, its default, and the effect
  of flipping it — verified against the branch in code, not assumed.
- The `verified_against` frontmatter SHA and the `source_paths` list are how a
  future reader (or a staleness checker) knows *what* you checked and *when*. They
  are part of the claim. Fill them honestly.

Excluded from "the tree": never cite or read from `node_modules/`,
`.claude/worktrees/`, or generated build output as a source of truth.

## Frontmatter contract

Every markdown doc under `docs/` **MUST** begin with this YAML frontmatter block,
as the literal first bytes of the file (no blank line, no BOM before `---`):

```yaml
---
title: <Human Title>
subsystem: <slug | "cross-cutting">
audience: [contributor, ai-agent]
status: current
last_verified: 2026-05-30
verified_against: 4359406        # git short SHA the doc was checked against
source_paths:                    # the code files this doc describes
  - <relative/path/from/repo/root.ts>
related:                         # slugs of related docs
  - <slug>
---
```

### Field-by-field

| Field             | Type            | Required | Meaning / rules                                                                                                                                                          |
| ----------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | string          | yes      | Human-readable title in Title Case. Mirror the top-level `# H1` heading. Context cards append `— AI Context Card`.                                                       |
| `subsystem`       | string          | yes      | The owning subsystem **slug** (e.g. `orchestrator`, `music-model`, `editor-ui`), or `cross-cutting` for docs that span subsystems (architecture, guides, this file).    |
| `audience`        | list of strings | yes      | Who the doc is for. Allowed values: `contributor`, `ai-agent`. Order signals primary audience (context cards lead with `ai-agent`).                                     |
| `status`          | enum            | yes      | `current` \| `draft` \| `deprecated`. Only `current` docs are authoritative. Mark superseded docs `deprecated` and link the replacement — do not delete silently.       |
| `last_verified`   | ISO date        | yes      | `YYYY-MM-DD` you last checked the doc against code. Bump it **only** when you actually re-verified, not on cosmetic edits.                                                |
| `verified_against`| git short SHA   | yes      | The commit you verified against (e.g. `4359406`). Pairs with `last_verified`: together they pin the exact tree state the claims were true for.                          |
| `source_paths`    | list of paths   | yes      | Repo-root-relative paths to the **code files this doc describes**. This is the staleness signal: the staleness checker (`pnpm docs:check`) can diff these paths since `verified_against` and flag the doc for re-verification. List the files you actually read, not the whole subsystem. |
| `related`         | list of slugs   | yes      | Slugs of related docs (a doc's slug is its filename without `.md`, e.g. `orchestrator`, `data-flow`). Drives cross-navigation. May be empty (`[]`) but the key must be present. |

### Frontmatter invariants

- `source_paths` entries are **repo-root-relative** (`src/lib/...`), never
  absolute, never `./`-prefixed. Use them verbatim so tooling can `git log` them.
- `verified_against` must be a real commit that contains the `source_paths` —
  i.e. the SHA you had checked out when you read those files.
- `last_verified` + `verified_against` are a unit. Changing one without the other
  is a lie about what was checked. Bump both together, after re-reading the code.
- A doc whose `source_paths` have changed materially since its `verified_against`
  SHA is **presumed stale** until re-verified. Treat staleness as a doc bug.

> Legacy exception: a few early docs (e.g. `docs/local-models.md`) predate this
> contract and have no frontmatter. They are grandfathered, **not** a precedent.
> Any new or substantively edited doc must carry the full block.

## Writing style

Match `src/lib/orchestrator/README.md`. The voice is a precise senior engineer
writing for peers and AI agents who will act on what they read.

- **Dense and technical. No marketing fluff.** No "powerful", "seamless",
  "robust", "simply". State mechanism, not adjectives.
- **Document the WHY and the non-obvious**, not the what. Anyone can read the
  code for *what*. The doc earns its keep by capturing **gotchas, invariants,
  footguns, rollout/back-compat seams, and the reasoning** that isn't on the
  screen. Prefer "trust-nothing-the-LLM-says: the verifier re-hashes retained
  bars" over "the verifier checks the bars".
- **Code-pointer-rich.** Reference code as relative paths with the symbol, e.g.
  `` `src/lib/music/validateScore.ts:validateScore` `` or
  `` `src/lib/orchestrator/index.ts:run` ``. Paths must be **real and clickable**
  (relative-from-repo-root). Symbols must exist. This is the verification rule
  applied to prose: a pointer you didn't open is a claim you can't make.
- **Call out env flags explicitly** with their **DEFAULT** and **effect**: name,
  default, what flipping it does, and the rollback path. Mirror the flag table in
  the orchestrator README.
- **Call out invariants** the code enforces (e.g. "measure durations must sum to
  the meter; `validateScore` rejects otherwise"). Name the enforcer.
- **Prefer small tables and ASCII diagrams** over long prose where they fit. A
  data-flow arrow diagram or a `Flag | Default | Purpose` table conveys more,
  faster, than three paragraphs. See the architecture diagram in the orchestrator
  README for the bar.
- **Code fences are illustrative, not authoritative.** Keep inline snippets short
  and load-bearing (a type shape, a signature, the exact gate condition). Do not
  paste large code blocks the reader can open instead.
- **End every substantive doc** with a `## Related files` or `## See also`
  section listing the real paths it draws on. (This complements, and should agree
  with, `source_paths` in the frontmatter.)

### Quick checklist before you commit a doc

1. Frontmatter present, complete, first bytes of file.
2. `source_paths` list = the files you actually opened; `verified_against` = the
   SHA you had checked out.
3. Every code path/symbol named was opened and exists at that SHA.
4. Every flag has default + effect + rollback.
5. Invariants name their enforcer.
6. Tables/diagrams used where they beat prose.
7. `## Related files` / `## See also` at the end with real paths.
8. No fluff adjectives; the doc explains *why*, not just *what*.

## Doc taxonomy — what lives where

`docs/` is organized by **audience and altitude**, not by feature. Place a new
doc by asking "who reads this and at what zoom level," then pick the directory.

```
docs/
├── _meta/                  this contract + any docs-about-docs
├── architecture/           system-wide, cross-cutting — the 30,000-ft view
├── subsystems/             one file per subsystem — the deep reference
├── guides/                 task-oriented how-tos (onboarding, workflow)
├── reference/              flat lookups (env-flag index, glossary-style tables)
├── contributing/           process / conventions for changing the repo
└── ai-agents/              agent-optimized material
    └── context-cards/      one terse card per subsystem, ai-agent-first
```

| Directory                   | Slug in `subsystem`      | Audience lead | What belongs here                                                                                                                                                  | What does NOT                                                              |
| --------------------------- | ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `architecture/`             | `cross-cutting`          | contributor   | System-wide views that span ≥2 subsystems: end-to-end data flow, the boot sequence, the shared glossary, the big-picture overview. See `docs/architecture/overview.md`. | Single-subsystem mechanics (those go in `subsystems/`).                   |
| `subsystems/`               | the subsystem's own slug | contributor   | The authoritative deep reference for **one** subsystem — its files, invariants, flags, gotchas. One file per subsystem. See `docs/subsystems/orchestrator.md`.       | Cross-cutting flows; step-by-step tutorials.                              |
| `guides/`                   | `cross-cutting` (usually)| contributor   | Task-oriented, procedural how-tos: getting started, the dev workflow, running evals locally. See `docs/guides/getting-started.md`.                                | Reference material; subsystem internals (link to them instead).          |
| `reference/`                | `cross-cutting`          | contributor   | Flat, scannable lookups: the consolidated env-flag table, command index, schema-field tables. Optimized for Ctrl-F, not narrative.                                  | Prose explanation of *why* (that's `subsystems/`).                        |
| `contributing/`             | `cross-cutting`          | contributor   | How to change the repo safely: PR conventions, the milestone/PR-numbering scheme, the doc contract's enforcement, review expectations.                              | Code architecture (that's `architecture/`/`subsystems/`).                 |
| `ai-agents/`                | varies                   | ai-agent      | Material written **for** AI agents acting on the codebase: navigation maps, agent playbooks.                                                                        | Long human-onboarding prose.                                              |
| `ai-agents/context-cards/`  | the subsystem's own slug | ai-agent      | One **terse** card per subsystem: entry points, key files with a one-line each, the non-obvious wiring an agent needs to act fast. Mirrors a `subsystems/` doc but compressed. See `docs/ai-agents/context-cards/orchestrator.md`. | Tutorial prose; anything that duplicates the full subsystem doc verbatim. |

**Subsystem ↔ context-card pairing.** Most subsystems have both a deep doc
(`docs/subsystems/<slug>.md`) and a context card
(`docs/ai-agents/context-cards/<slug>.md`). They share the `<slug>` and should
cross-link via `related`. The subsystem doc is the source of depth; the card is
the agent's fast index into it. Keep them consistent — when you update one's
facts, re-verify the other.

**In-tree READMEs are first-class.** Some subsystems keep their authoritative
reference next to the code (e.g. `src/lib/orchestrator/README.md`,
`evals/README.md`). When that exists, the `docs/subsystems/` doc should point to
it as the deep source rather than duplicate it. Do not fork the truth into two
places that can drift.

## Naming conventions

- **Filenames**: lowercase, hyphen-separated, `.md` (e.g. `data-flow.md`,
  `getting-started.md`, `ghost-preview.md`). The filename minus `.md` is the
  doc's **slug**, used in `related:` lists and `subsystem:` where applicable.
- **One file per subsystem** in both `subsystems/` and `context-cards/`, named
  for the subsystem slug. The slug is stable — it's how docs reference each other.
- **Slugs match across the pair**: `docs/subsystems/orchestrator.md` and
  `docs/ai-agents/context-cards/orchestrator.md` both use slug `orchestrator`.
- **`_meta/`** uses `SCREAMING_SNAKE` for the few canonical contract files
  (`STYLE_GUIDE.md`) to visually flag them as governance docs, not content.
- **Headings**: one `# H1` per file matching `title`. Use `##`/`###` for
  structure. Sentence-case `## Section headings` (matching the orchestrator
  README), not Title Case.
- **Cross-links**: relative markdown links between docs
  (`../subsystems/orchestrator.md`, `../reference/env-flags.md`), never absolute
  filesystem paths in link targets. Code references inside backticks use
  repo-root-relative paths (`src/lib/...`).

## Cross-linking

- Link **down** from architecture/guides into the relevant `subsystems/` doc;
  link **across** between sibling subsystems via `related`.
- Every `related:` slug should resolve to a real doc file. A dangling slug is a
  doc bug.
- When a `subsystems/` doc has an in-tree README counterpart, the README is the
  deep source — link to it, don't restate it.

## See also

- `src/lib/orchestrator/README.md` — the reference implementation of the target
  tone, depth, flag-table, and ASCII-diagram style.
- `docs/architecture/overview.md` — canonical example of a `cross-cutting`
  architecture doc and its frontmatter.
- `docs/subsystems/orchestrator.md` — canonical example of a subsystem deep doc.
- `docs/ai-agents/context-cards/orchestrator.md` — canonical example of a terse,
  ai-agent-first context card.
- `docs/guides/getting-started.md` — canonical example of a procedural guide.
