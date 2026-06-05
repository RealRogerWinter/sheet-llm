---
title: chunk Sidecars — Inner-Loop Validation for AI Agents
subsystem: ops
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: 41d2402
source_paths:
  - .chunk/config.json
  - scripts/chunk/agent-hook.mjs
  - scripts/chunk/bootstrap.sh
  - .claude/settings.json
related:
  - ci-cd-pipeline
  - development-workflow
  - evals-testing
---

# chunk Sidecars — Inner-Loop Validation for AI Agents

[chunk](https://github.com/CircleCI-Public/chunk-cli) gives an AI coding agent
**inner-loop validation**: instead of waiting for the full CircleCI pipeline
(`install → lint/typecheck/test/checks → …`, see
[CI/CD Pipeline](ci-cd-pipeline.md)) to catch a mistake *after* a push, the
agent gets feedback *while it is still working*, from an environment that
mirrors CI. It runs as two committed hooks:

| Gate | When | What runs | Where |
| --- | --- | --- | --- |
| **commit-gate** | the agent is about to `git commit` | `pnpm typecheck` (fast) | locally |
| **stop-gate** | the agent tries to end its turn | `chunk validate` → the `test`/`typecheck` gates | a remote CircleCI **sidecar** microVM |

A **sidecar** is a short-lived microVM in your CircleCI org that mirrors CI. A
**snapshot** is a frozen sidecar image (node + `pnpm install` already done) that
new sidecars boot from, so validation starts in seconds instead of
re-installing every time.

This setup is committed to the repo, so **every contributor's agent runs it** —
including on Windows, where chunk (a macOS/Linux-only binary) is reached through
WSL.

## How the gates are wired

`.claude/settings.json` registers two hooks that both shell out to one
cross-platform launcher, [`scripts/chunk/agent-hook.mjs`](../../scripts/chunk/agent-hook.mjs):

- **PreToolUse** (matcher `Bash`) → `node … agent-hook.mjs commit-gate`. The
  launcher only acts on `git commit` Bash calls; for those it runs
  `pnpm typecheck` and **blocks the commit (exit 2)** on a type error.
- **Stop** → `node … agent-hook.mjs stop-gate`. The launcher runs
  `chunk validate`; a failure **blocks the turn (exit 2)** so the agent fixes it
  before stopping. It honors `stop_hook_active` to avoid re-entrant loops.

The launcher is **platform-aware and fail-safe**:

- **Windows** → it dispatches the gate into **WSL** (`wsl -e bash -lc …`),
  translating the repo path to `/mnt/c/…`, because chunk only ships for
  macOS/Linux.
- **macOS/Linux** → it runs the gate natively.
- **chunk / pnpm / WSL not installed** → the gate prints a one-line hint and
  **exits 0 (non-blocking)**, so an un-onboarded machine is never bricked. Run
  the bootstrap below to opt in.

Because the launcher derives the repo root from its own location, it behaves
identically for any agent that supports command hooks (Claude Code today;
Cursor/Codex can point their hook config at the same script).

## One-time setup

> Windows users: do all of this **inside WSL** (`wsl`), not PowerShell — chunk
> is a Linux/macOS binary. Node, pnpm and jq already live in the WSL distro.

```bash
# 1. Install chunk (macOS Homebrew, or the prebuilt Linux/WSL tarball).
bash scripts/chunk/bootstrap.sh

# 2. Authenticate against CircleCI (token: https://app.circleci.com/settings/user/tokens).
#    chunk reads these env vars directly; `chunk auth set` is interactive-only.
export CIRCLE_TOKEN=<your-circleci-api-token>
export CIRCLECI_ORG_ID=<your-org-id>

# 3. Boot a sidecar from the shared snapshot and make it active for this repo.
#    (Auto-created sidecars are bare; you must base on a node snapshot — see below.)
chunk sidecar create --image <snapshot-id> --org-id "$CIRCLECI_ORG_ID"

# 4. Sanity-check.
chunk validate --list        # shows the configured gates
chunk validate --remote      # runs them on the sidecar
```

Persist `CIRCLE_TOKEN` / `CIRCLECI_ORG_ID` in your shell profile (or a tool like
`direnv`) so the stop-gate can reach the sidecar on every turn.

## `.chunk/config.json` — the gates and environment

```jsonc
{
  "commands": [                       // what `chunk validate` runs on the sidecar
    { "name": "install",   "run": "pnpm install --frozen-lockfile" },
    { "name": "typecheck", "run": "pnpm typecheck", "role": "gate", "timeout": 300, "limit": 1 },
    { "name": "test",      "run": "pnpm test",      "role": "gate", "timeout": 600, "limit": 3 }
  ],
  "vcs": { "org": "RealRogerWinter", "repo": "sheet-llm" },
  "environment": {                    // how a sidecar is prepared / snapshotted
    "stack": "typescript",
    "setup": [
      { "name": "system",  "command": "command -v corepack >/dev/null 2>&1 && corepack enable && corepack prepare pnpm@9.15.9 --activate || npm install -g pnpm@9.15.9" },
      { "name": "install", "command": "pnpm install --frozen-lockfile" }
    ],
    "image": "cimg-node",
    "image_version": "24.15"
  }
}
```

- `role: "gate"` commands are the ones the stop-gate enforces; `limit` is the
  retry cap chunk applies for flaky gates.
- The sidecar base is **`cimg-node:24.15`** (node + corepack + pnpm pre-baked).
  The app's `engines` only require node `>=20.9`; CI and the production image pin
  **22.14** (see [Dockerfile / CI](ci-cd-pipeline.md)), so the sidecar's node 24
  is a near-mirror for the fast inner loop, with CI at 22.14 as the source of
  truth. There is no pre-baked `cimg-node:22` in the sidecar catalog, which is
  why 24.15 is used here.
- `.chunk/sidecar*.json` (the active-sidecar handle) is **machine-local and
  git-ignored**; only `config.json` is committed.

## Creating / refreshing the snapshot

A snapshot bakes `pnpm install` (incl. the `better-sqlite3` native build) into a
reusable image. Rebuild it when `pnpm-lock.yaml` changes materially:

```bash
export CIRCLE_TOKEN=… CIRCLECI_ORG_ID=…
# Base on the node snapshot (NOT an auto-created bare sidecar), run the setup
# steps from .chunk/config.json, then freeze the result:
SID=$(chunk sidecar create --image <cimg-node:24.15 id> --name sheet-llm-build \
        --org-id "$CIRCLECI_ORG_ID" | grep -oE '[0-9a-f-]{36}' | head -1)
chunk sidecar setup --dir . --sidecar-id "$SID"   # installs deps, then snapshots
chunk sidecar snapshot list --org-id "$CIRCLECI_ORG_ID"   # note the new snapshot id
```

> Gotcha worth remembering: `chunk sidecar setup` *without* a `--sidecar-id`
> auto-creates a **bare** microVM (no node), so its setup step fails with
> `npm: command not found`. Always base the sidecar on the `cimg-node` snapshot
> first (`chunk sidecar create --image …`), then run `setup` against that id.

## Opting out / disabling

> Cost note: the stop-gate boots a CircleCI sidecar on **every** turn (real
> CircleCI usage; up to a few minutes per turn before the snapshot warms it).
> If that cadence is too expensive for a given checkout, disable it per-repo with
> `chunk hook disable`.

- Per-repo, temporarily: `chunk hook disable` (re-enable with `chunk hook enable`).
- Per-machine: don't install chunk — the hooks degrade to a no-op automatically.
- Personal overrides go in `.claude/settings.local.json` (git-ignored); never
  edit the committed `.claude/settings.json` to disable a gate for everyone.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Stop-gate prints "chunk not installed — skipping" | chunk isn't on PATH (in WSL on Windows). Run `bash scripts/chunk/bootstrap.sh`. |
| `npm: command not found` during `sidecar setup` | The sidecar is a bare base. Create from the `cimg-node` snapshot first (see above). |
| Stop-gate hangs / times out | First sidecar boot with no snapshot installs deps from scratch. Create a snapshot, then sidecars boot fast. |
| Commit-gate slow on Windows | It runs `pnpm typecheck` in WSL over `/mnt/c`. Expected; it only fires on `git commit`. |
| Auth errors | `export CIRCLE_TOKEN` and `CIRCLECI_ORG_ID`; `chunk auth set` needs an interactive TTY and is not used here. |

See also: [CI/CD Pipeline](ci-cd-pipeline.md) (the outer loop these gates
mirror), [Development Workflow](development-workflow.md), and
[Testing & Eval Harness](../subsystems/evals-testing.md).
