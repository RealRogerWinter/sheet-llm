---
title: Documentation Maintenance Protocol
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - scripts/docs/check-doc-freshness.ts
  - docs/architecture/overview.md
  - docs/subsystems/ghost-preview.md
  - docs/ai-agents/context-cards/ghost-preview.md
  - docs/reference/scripts.md
  - package.json
related:
  - orchestrator
---

# Documentation Maintenance Protocol

This is the operating manual for the `docs/` tree itself: how a doc proves it
is still correct, how the system *detects* when a doc has drifted from the code
it describes, and the exact procedure to re-verify and re-stamp one. It is the
future-proofing core — the part that keeps a large, AI-and-human-maintained doc
set from silently rotting as the codebase moves underneath it.

The single load-bearing idea: **every doc declares the code it describes, and a
checker can therefore prove staleness mechanically.** A doc is not "fresh"
because someone felt it was — it is fresh because its `source_paths` have not
changed in git since its `verified_against` commit. That is a falsifiable claim,
and the maintenance protocol is built around making it cheap to check and cheap
to renew.

> **Status of the tooling.** The *frontmatter contract*, the *doc tree*, **and
> the automated checker are all real and on disk** at `150cb15`. The checker is
> `scripts/docs/check-doc-freshness.ts`, run via `pnpm docs:check` (the script
> alias is in `package.json`). There is no CI automation — the checker is run
> locally / on demand. Everything below you can verify by reading the file path
> given. (Earlier revisions of this doc described the checker, `pnpm docs:check`,
> `docs/llms.txt`, and `docs/_meta/STYLE_GUIDE.md` as **(specified)**
> — code-not-yet-on-disk; all four now exist and the (specified) tags have been
> removed accordingly.)

---

## The doc tree

```
docs/
├── architecture/        cross-cutting system docs (the hub lives here)
│   ├── overview.md        ← THE HUB: "Subsystem map" table links every subsystem
│   ├── data-flow.md       ├ end-to-end request flow
│   ├── data-model.md      ├ the Score tree
│   └── glossary.md        └ shared vocabulary
├── subsystems/          one deep-dive per subsystem (the BAR for depth)
│   └── <slug>.md          e.g. orchestrator.md, music-model.md, auth-data-lifecycle.md
├── ai-agents/
│   ├── AGENT_GUIDE.md            ← agent orientation / golden rules
│   ├── maintenance-protocol.md   ← this file
│   └── context-cards/   one condensed, agent-optimized card per subsystem
│       └── <slug>.md      mirrors subsystems/<slug>.md, same frontmatter
├── guides/              task-oriented (getting-started, development-workflow,
│                        durability-runbook, …)
├── reference/           flat references (env-flags, scripts, api-routes)
├── contributing/        CONTRIBUTING.md — how a change lands
├── _meta/               this protocol's siblings: STYLE_GUIDE.md, coverage.md
└── llms.txt             machine-readable site index (no frontmatter)
```

Three invariants hold across the tree and the checker keys off them:

| Invariant | Why |
| --- | --- |
| Every `*.md` under `docs/` carries the full frontmatter block (below). | The checker parses frontmatter (`source_paths` + `verified_against` + `last_verified` are required) and errors on a doc that lacks it — so a doc with none can't be freshness-tracked. (Exception: `docs/llms.txt` and `docs/local-models.md` carry no frontmatter; the checker only walks `*.md`, and `llms.txt` is therefore skipped, while `local-models.md` is grandfathered.) |
| A subsystem `slug` equals the basename of `docs/subsystems/<slug>.md` (and, for subsystems that have one, `docs/ai-agents/context-cards/<slug>.md`). | `related:` entries and the hub's links resolve by slug → file with no lookup table. Verified at `150cb15`: the `subsystem:` field values match the subsystem filenames. |
| **Most** subsystems have a 1:1 deep doc + context card with the **same** `subsystem`, `source_paths`, and `verified_against` (16 cards, one per paired subsystem). | Card and deep doc go stale together; one checker pass covers both. Compare `docs/subsystems/ghost-preview.md` and `docs/ai-agents/context-cards/ghost-preview.md` — identical frontmatter, different density. Newer subsystem docs may ship without a card yet (e.g. `docs/subsystems/auth-data-lifecycle.md`, `subsystem: auth`, has no card); that is a backlog item, not a contract violation. |

The **hub** is `docs/architecture/overview.md`. Its *Subsystem map* table is the
canonical index of every subsystem doc; a new subsystem is "in the system" only
once it appears there.

---

## The frontmatter contract

Every doc opens with this YAML block. It is not decoration — three of the eight
fields (`source_paths`, `verified_against`, `last_verified`) exist *solely* to
make staleness mechanically detectable.

```yaml
---
title: <Human Title>
subsystem: <slug | cross-cutting>
audience: [contributor, ai-agent]
status: current
last_verified: 2026-05-30
verified_against: 4359406        # git short SHA the doc was checked against
source_paths:                     # the code files this doc describes
  - src/lib/orchestrator/index.ts
  - src/lib/music/scoreDiff.ts
related:                          # slugs of related docs
  - orchestrator
---
```

| Field | Type | Role | Allowed / observed values @ `150cb15` |
| --- | --- | --- | --- |
| `title` | string | Human-facing title; rendered as the page H1 equivalent. | free text |
| `subsystem` | slug \| `cross-cutting` | Which subsystem this doc belongs to. Drives card↔deep-doc pairing and hub grouping. | a subsystem slug (e.g. `orchestrator`, `music-model`, `ghost-preview`, plus newer `auth` / `ops` for the accounts docs) or `cross-cutting` |
| `audience` | string[] | Who the doc is written for. | `[contributor, ai-agent]` (order not significant) |
| `status` | enum | Lifecycle. Stale-but-kept docs flip to `outdated`/`deprecated` rather than getting deleted, so links don't 404. | `current` is the only value in use; reserve `outdated`, `deprecated` |
| `last_verified` | ISO date | Human date a person/agent last re-read the doc against the code. | `YYYY-MM-DD` |
| `verified_against` | git short SHA | **The commit the doc was checked against.** The freshness baseline. | a real short SHA reachable in history (varies per doc; most docs sit at `150cb15` after the latest sweep) |
| `source_paths` | string[] | **The code files this doc describes**, repo-root-relative. The staleness signal. | real paths that exist on disk |
| `related` | slug[] | Sibling docs by slug, for cross-navigation. | subsystem slugs |

### Why `source_paths` exists

`source_paths` is the keystone. Prose can lie or quietly decay; a path-plus-SHA
pair cannot. The contract it encodes is:

> *"As of commit `verified_against`, this doc accurately describes the listed
> files. If any of those files changed in a commit **after** `verified_against`,
> this doc is **possibly stale** and must be re-verified."*

This converts "is the doc still right?" — unanswerable in general — into "did
`git log <verified_against>..HEAD -- <source_paths>` return anything?" — a
one-command query. That is the entire mechanism. List in `source_paths` exactly
the files whose change would invalidate the doc's claims (the files you actually
read to write it), and no more: padding the list creates false-positive
staleness; under-listing lets real drift slip through silently.

Pick `source_paths` to match the doc's altitude:

- A **subsystem deep doc** lists its subsystem's core files (its `Entry` +
  `Key files`). See `docs/subsystems/ghost-preview.md` — 11 paths covering the
  server hook, flags, client store, and the three UI components.
- A **cross-cutting doc** lists the seam files it actually reasons about
  (`docs/architecture/overview.md` lists ~12 spanning route → orchestrator →
  model → db → providers).
- This protocol doc lists representative *exemplars* of the doc system
  (the hub, a deep/card pair, the scripts reference) plus the `package.json`
  manifest it governs — because what it "describes" is the documentation
  machinery, not one subsystem.

---

## The staleness workflow

### `scripts/docs/check-doc-freshness.ts`

The checker is a `tsx` script (the repo's standard for `scripts/*.ts` — see
`docs/reference/scripts.md`; `tsx` is a devDependency in `package.json`), run via
the `docs:check` alias. It walks `docs/**/*.md` (skipping `node_modules` and any
dot-directory; non-`.md` files such as `llms.txt` are not visited). For each doc
it:

1. Parses the leading `---`-fenced YAML frontmatter directly — there is
   deliberately **no `gray-matter` dependency**; the parser is hand-rolled and
   supports only the fixed `key: scalar` / `key:` + `- item` shapes the template
   uses (`parseFrontmatter`). It extracts `source_paths`, `verified_against`, and
   `last_verified`.
2. Records any **missing required field** (`source_paths`, `last_verified`,
   `verified_against`) — a doc with none/incomplete frontmatter is reported, not
   silently passed.
3. For each `source_path`, flags it as **broken** if the file/dir does not exist
   on disk (`existsSync`).
4. For each still-existing `source_path`, runs
   `git log --oneline <verified_against>..HEAD -- <path>` (`countCommitsSince`);
   any commits in range → the doc is **stale** for that path.
5. Exits non-zero when any doc is stale / broken / missing-frontmatter, zero
   otherwise.

The human ledger groups findings under `## MISSING FRONTMATTER`,
`## BROKEN source_paths`, and `## STALE`, e.g.:

```
$ pnpm docs:check

# Doc freshness — checked 39 doc(s)

## STALE (1) — source changed since verified_against
  docs/subsystems/ghost-preview.md
    2 commit(s) since verified: src/lib/orchestrator/index.ts

Re-read the changed source, update the doc prose, then bump
`last_verified` (today) and `verified_against` (current HEAD short SHA).
```

Edge cases the checker handles (each a real footgun):

| Case | Behavior |
| --- | --- |
| `verified_against` not reachable / a bad SHA (rebased/squashed away) | The `git log` throws; caught and reported as a stale-style finding (`commits: -1`, printed as "git error (bad verified_against SHA?)") — never crashes. |
| A `source_path` no longer exists on disk | Reported under **BROKEN source_paths**; that path is then skipped for the freshness diff so a missing file can't masquerade as "fresh". |
| Doc has no frontmatter / missing a required field | Reported under **MISSING FRONTMATTER** — an untracked doc is worse than a stale one. |
| Path changed only by formatting/rename | Still flagged — the checker is intentionally conservative; a human decides if the prose actually needs an edit. False positives are cheap, false negatives are not. |

### Running the checker

There is no CI automation — `pnpm docs:check` is a local, on-demand step. Run it
after editing code that a doc's `source_paths` covers, and before opening a PR,
so drift is caught while you still have the context to fix it. Pass
`--report-only` for a non-failing report (always exits 0); `--json` emits a
machine-readable report instead of the ledger. The default exits non-zero on any
stale, broken, or missing-frontmatter doc. The checker shells out to
`git log <verified_against>..HEAD`, so run it against a complete checkout with
full history, not a shallow clone.

---

## Re-verifying and re-stamping a doc

When the checker (or your own reading) flags a doc, the human/agent loop is:

1. **Read the changed code.** Open every `source_path` the checker reported as
   changed and read the diff: `git log -p <verified_against>..HEAD -- <path>`.
   Read the *file*, not just the diff — the doc must match current reality, and
   a prior edit may have already drifted.
2. **Reconcile the prose.** Fix every claim the change invalidated: paths,
   export names, line-number anchors (e.g. `state.ts:809`), flag defaults,
   invariants, ASCII diagrams. Every fact you write must be one you just saw on
   disk — the same grounding rule that governs writing a doc from scratch.
3. **Re-stamp the frontmatter** once the prose is correct against `HEAD`:
   - `last_verified:` → today's date.
   - `verified_against:` → the current short SHA (`git rev-parse --short HEAD`).
   - Update `source_paths` if the doc now covers different/renamed files.
4. **Update the paired card too.** A subsystem deep doc and its
   `context-cards/<slug>.md` share frontmatter; re-stamp both in the same change
   or the checker will immediately re-flag the laggard.
5. **Commit doc + stamp together.** The stamp's whole value is that it
   corresponds to a real point in history; never bump `verified_against` without
   actually re-reading at that commit.

> **The cardinal rule:** `verified_against` is a *promise that a human or agent
> re-read the code at that SHA*. Bumping it to silence the checker without
> re-reading defeats the entire system. If you only confirmed part of a doc,
> fix what you can and leave the stamp — a flagged doc is honest; a falsely
> fresh one is a trap.

A doc that is genuinely outdated and not worth fixing immediately should flip
`status: outdated` (and say why at the top) rather than be left silently wrong —
links keep resolving, and readers are warned.

---

## Adding a new subsystem doc

When a new subsystem lands (or an existing surface grows large enough to earn
its own doc), wire it into **every** index so it isn't an orphan:

1. **Copy the template.** Start from an existing deep doc whose shape fits
   (`docs/subsystems/ghost-preview.md` is a good, recent exemplar) and from its
   card (`docs/ai-agents/context-cards/ghost-preview.md`). Keep the section
   skeleton: Purpose → Entry points → Key files → Core concepts/data flow →
   Invariants & gotchas → How to extend → Env flags → Testing → Related files.
2. **Set frontmatter.** Choose a `slug`, set `subsystem: <slug>`, fill
   `source_paths` with the files you actually read, and stamp `last_verified` +
   `verified_against` with today's date and `git rev-parse --short HEAD`.
   The deep doc and the card share `subsystem`/`source_paths`/`verified_against`.
3. **Add it to the hub.** Append a row to the *Subsystem map* table in
   `docs/architecture/overview.md` (and, if it changes the block diagram, the
   diagram). A subsystem not in the hub is invisible.
4. **Add a context card.** Create `docs/ai-agents/context-cards/<slug>.md` — the
   condensed, agent-optimized mirror of the deep doc. Cards exist so an AI agent
   can load just the dense facts (key files, types/exports, gotchas, "when
   editing X also update Y") without the full prose. (A few recent subsystem docs
   ship the deep doc before the card — e.g. `subsystems/auth-data-lifecycle.md` —
   but the card is the goal; don't leave the deep doc cardless indefinitely.)
5. **Register it in `llms.txt`.** `docs/llms.txt` is the machine-readable site
   index agents fetch first (the [llmstxt.org](https://llmstxt.org) convention);
   it lists each doc with a one-line summary so an agent can route to the right
   file. Add the new doc's path + summary there too. (`llms.txt` carries no
   frontmatter and is not walked by the checker, so this step is manual.)
6. **List it in the human hub too.** Add the doc to the relevant section table in
   `docs/README.md` and update `docs/_meta/coverage.md` (one row per doc).
7. **Cross-link.** Add the new slug to the `related:` lists of adjacent docs and
   add real relative links (`../subsystems/<slug>.md`) in their "See also"
   sections, so navigation is bidirectional.

After step 2, the checker starts tracking the new doc automatically — there is no
registry to update; presence under `docs/**/*.md` plus valid frontmatter is the
only enrollment.

---

## `docs/_meta/STYLE_GUIDE.md`

`docs/_meta/STYLE_GUIDE.md` is the prose-and-format companion to this protocol:
this file governs *freshness*, the style guide governs *how a doc reads*. It
codifies the conventions already visible across the tree (and modeled by the BAR
reference, `src/lib/orchestrator/README.md`):

- Precise, dense, technical — no marketing language.
- Code referenced as clickable relative paths with symbols
  (`src/lib/music/validateScore.ts:validateScore`); every path must be real.
- Prefer small tables and ASCII diagrams over long prose.
- Document the WHY and the non-obvious (gotchas, invariants, footguns,
  rollout/back-compat seams), not just the what.
- Call out env flags with their **default** and effect; call out invariants the
  code enforces.
- End substantive docs with a "Related files" / "See also" list of real paths.

The grounding rule both documents share: **a fact you state — a path, an export,
a flag default, a behavior — must be one you verified by opening the file.**
That rule is *why* the freshness checker can work at all: it presumes docs were
true at `verified_against`, and only needs to detect change, not re-judge
correctness.

---

## Related files / See also

- `docs/architecture/overview.md` — the hub; its *Subsystem map* is the
  canonical doc index every new subsystem must join.
- `docs/subsystems/ghost-preview.md` + `docs/ai-agents/context-cards/ghost-preview.md`
  — the deep-doc / context-card pairing template (identical frontmatter,
  different density).
- `docs/reference/scripts.md` — the `scripts/` + `package.json` conventions the
  freshness checker follows (`tsx`, `pnpm run`, the `--` arg-passing gotcha).
- `src/lib/orchestrator/README.md` — the BAR for tone and depth in this doc set.
- `package.json` — `tsx` devDependency; the future `docs:check` script alias.
