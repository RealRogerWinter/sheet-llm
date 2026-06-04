---
title: CI/CD Pipeline & Build-in-Public Philosophy
subsystem: ops
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: 5509a03
source_paths:
  - .circleci/config.yml
  - deploy/deploy.sh
  - Dockerfile
related:
  - deploy-vps
  - security-hardening
  - development-workflow
---

# CI/CD Pipeline & Build-in-Public Philosophy

`sheet-llm` ships through a single CircleCI pipeline: every push runs a
parallel verification gate; merges to `main` build and push a Docker image to a
**public** GHCR registry, then **wait for a human to approve** before a
pull-based deploy to the VPS. This guide documents the pipeline
(`.circleci/config.yml`) and the build-in-public values that shape it.

## Pipeline shape

```
install ─┬─ lint        (report-only)
         ├─ typecheck
         ├─ test         (parallelism 4, timing-split)
         └─ checks       (abcjs spike · eval:mock · eval:visual[report-only] · schema-drift)
                          │  (all of typecheck+test+checks must pass, main only)
                          ▼
                    build_and_push ──▶ hold (manual approval) ──▶ deploy
```

### `install`
Corepack-pins `pnpm`, restores the pnpm store + `.next/cache`, installs with
`--frozen-lockfile`, and persists the workspace to every downstream job.

### The verification gate (parallel, deterministic, secret-free)
- **`lint`** — runs but is **report-only** (the squashed public-release commit
  carries one pre-existing ESLint error; lint is informational until it's
  cleaned up, so it never blocks).
- **`typecheck`** — `tsc --noEmit`, blocking.
- **`test`** — Vitest across 4 containers using **smarter testing**:
  `circleci tests glob … | circleci tests split --split-by=timings
  --timings-type=classname` balances each container's file list by *historical
  per-file timing* rather than file count. Vitest's JUnit records the spec path
  in `classname` (there is no per-case `file=` attribute), so the split keys on
  `classname`; `store_test_results` feeds Test Insights and flaky detection. The
  first run with no timing data auto-falls-back to a filesize split. `--retry=2`
  de-flakes the two known-flaky specs.
- **`checks`** — `abcjs:spike`, `eval:mock` (key-free), `eval:visual`
  (**report-only**: abcjs/jsdom renders are environment-specific in CI), and a
  **schema-drift guard** that runs `db:generate` and fails if it produces a
  diff — i.e. the committed Drizzle migrations must match the schema.

### `build_and_push` (main only)
Builds the multi-stage `Dockerfile` and pushes to
`ghcr.io/realrogerwinter/sheet-llm` with `setup_remote_docker` and
`--password-stdin`, using a **dedicated `write:packages`-only** token in the
restricted `ghcr-push` context (never a broad admin PAT). It records the
resulting **image digest** to the workspace for the deploy job. The image is
public, so the VPS pulls anonymously — no registry credential lives on the
server.

### `hold` → `deploy` (main only)
`hold` is a `type: approval` job: nothing deploys without a human click.
`deploy` (restricted `vps-deploy` context) pins the VPS host key from
`VPS_KNOWN_HOSTS` (`StrictHostKeyChecking=yes` — no trust-on-first-use), loads
the deploy SSH key via `add_ssh_keys`, and sends **only the image digest** as
`SSH_ORIGINAL_COMMAND` to `deploy@<host>`.

On the server, that key is locked to a forced command running
`deploy/deploy.sh` (root-owned, narrow sudoers; the `deploy` user is not in the
`docker` group). The script accepts **only** an anchored `sha256:<64 hex>`
digest, writes it to `.image` (keeping `.image.prev`), and runs
`docker compose pull && up -d`. See
[deploy-vps.md](deploy-vps.md#how-a-deploy-happens) and
[security-hardening.md](security-hardening.md#least-privilege-deploy).

### Why approval is a gate, not access control
A restricted context does **not** gate *who* may click approve — any project
member can. The protection is that all deploy credentials live **only** in the
restricted `vps-deploy` context, so an unauthorized approval hard-fails before
any side effect, and project membership is kept minimal. Approver identity is
*auditable*, not *preventable*.

## Build in public

This project is built in the open, on purpose. The philosophy is simple:
**if a control only works because it's hidden, it isn't a control.** Everything
that *can* be public, is — and the things that genuinely can't be (secrets) are
structurally excluded rather than merely hidden.

- **Public repository, public CI config, public image.** The source, this
  `.circleci/config.yml`, and the runtime image
  (`ghcr.io/realrogerwinter/sheet-llm`) are all public. Anyone can read how the
  app is built, tested, hardened, and shipped. The VPS pulls the image
  anonymously — there is no private-registry secret to leak.
- **Secrets are excluded by construction, not obscurity.** No secret is ever in
  the repo, the image, a build arg, or a log. They exist only at runtime in the
  host `.env` (`600 root:root`). The image is scanned to prove it: a public
  image is safe precisely because there is nothing sensitive in it. See
  [security-hardening.md](security-hardening.md#secret-hygiene).
- **The security model is documented, not secret.** The
  [threat model and every layer](security-hardening.md) are written down. A
  defense that survives being published (origin mTLS, IP-bound HMAC clearance,
  least-privilege forced-command deploy) is a real defense; one that depends on
  attackers not knowing the design is not.
- **Verifiable docs.** Every doc pins the `source_paths` it describes and a
  `verified_against` commit, so claims are checkable against the tree and rot is
  detected mechanically (`pnpm docs:check`). Honesty about state — including
  what's *not* done — is part of the contract; see the
  [maintenance protocol](../ai-agents/maintenance-protocol.md).
- **Humans stay in the loop on the irreversible step.** Continuous integration
  is fully automated; *deployment* is gated behind an explicit human approval.
  Building in public doesn't mean shipping on autopilot.

## CI hygiene notes

- **Skip CI for docs-only changes.** Include `[skip ci]` in the commit message
  (and the merge commit) so documentation PRs don't spend a pipeline run.
- **Pin tool versions** (Node, pnpm, abcjs) so the gate can't flake on an
  upstream bump.
