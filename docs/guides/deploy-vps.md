---
title: Self-Hosted VPS Deployment (Cloudflare + Caddy + Docker + Litestream)
subsystem: ops
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: 5509a03
source_paths:
  - Dockerfile
  - deploy/docker-entrypoint.sh
  - deploy/deploy.sh
  - next.config.ts
  - litestream.yml
  - src/app/api/health/route.ts
related:
  - durability-runbook
  - ci-cd-pipeline
  - security-hardening
---

# Self-Hosted VPS Deployment

This runbook describes how `sheet-llm` runs in production: a single Next.js
container behind Caddy on a hardened Ubuntu host, fronted by Cloudflare, with
SQLite replicated to Cloudflare R2 via Litestream. It is the companion to the
[CI/CD pipeline](ci-cd-pipeline.md) (which builds and ships the image) and the
[security hardening](security-hardening.md) guide (which locks the host down).

> **Where the configs live.** The application artifacts in this section
> (`Dockerfile`, `deploy/*.sh`, `next.config.ts`, `litestream.yml`) are
> committed. The *host* configs — `Caddyfile`, `docker-compose.yml`, the
> per-host `.env`, ufw rules — live only on the server and are **deliberately
> not committed** so no secret or origin-only detail is ever in the repo. They
> are documented here as prose.

## Topology

```
Browser ──TLS──▶ Cloudflare (Full-strict, proxied, Bot-Fight, rate-limit)
                   │  Authenticated Origin Pulls (mTLS): origin trusts only CF
                   │  origin 80/443 firewalled to Cloudflare IP ranges (ufw)
                   ▼
                Caddy on the HOST :443  (DNS-01 LE cert; reverse_proxy)
                   │  → 127.0.0.1:3000   (loopback only; never published)
                   ▼
                Docker: sheet-llm  (Next.js standalone `node server.js`, non-root)
                   └ Litestream supervises → SQLite /data/sheet-llm.db ──▶ Cloudflare R2
```

Only Caddy's `:80/:443` is ever public, and only to Cloudflare. The app listens
on `127.0.0.1:3000`; the database is never exposed. See
[security-hardening.md](security-hardening.md) for the origin-lock details.

## The image

`next.config.ts` sets `output: "standalone"` so the build emits a
self-contained `.next/standalone/server.js` the container runs directly. Two
non-obvious settings make the native SQLite driver and migrations work inside
the standalone bundle:

- `serverExternalPackages: ["better-sqlite3"]` — the native addon must not be
  bundled by the server compiler, or its prebuilt `.node` fails to load at
  runtime (`ERR_DLOPEN` / `NODE_MODULE_VERSION`).
- `outputFileTracingIncludes` traces the `drizzle/` migration directory into the
  output (it is read at runtime, not imported, so tracing won't include it on
  its own). The `Dockerfile` also explicitly `COPY`s `drizzle` for the
  boot-time migrator.

The multi-stage `Dockerfile` builds on a pinned `node:22-bookworm-slim` (build
stage == runtime stage Node major, or `better-sqlite3` throws
`NODE_MODULE_VERSION`), installs the Litestream binary and `tini`, creates a
non-root `app` user, and ships `.next/standalone`, `.next/static`, `public`,
`drizzle`, and the prebuilt better-sqlite3 `.node`. The image carries **no
secrets** — every secret is injected at runtime from the host `.env` (verified
by image scan; see [security-hardening.md](security-hardening.md)).

## Container start sequence

`deploy/docker-entrypoint.sh` (invoked by `tini` as PID 1) runs three steps:

1. **Privilege drop.** Starts as root only to `chown -R app:app /data` (a named
   Docker volume mounts root-owned; without this, better-sqlite3 cannot create
   the WAL sidecar files and the durability gate FATALs at boot), then
   re-execs itself as `app` via `gosu`.
2. **Cold-start restore.** Only when `/data/sheet-llm.db` is absent *and*
   `LITESTREAM_REPLICA_URL` is set, it runs
   `litestream restore -if-replica-exists`. `litestream replicate -exec` does
   **not** auto-restore, so this explicit restore is required;
   `-if-replica-exists` makes the first-ever boot (empty bucket) a no-op rather
   than an error.
3. **Run under supervision.** `litestream replicate -config … -exec
   "node server.js"`. Litestream is the supervisor: on `node` exit it performs a
   final WAL sync; `tini` forwards `SIGTERM` for a clean shutdown.

Health is `GET /api/health` (static 200; DB readiness is already enforced by the
FATAL boot gate). It is in Cloudflare's cache-bypass set.

## Host layout

```
/opt/sheet-llm/
  docker-compose.yml   # image: ${SHEETLLM_IMAGE}; ports 127.0.0.1:3000:3000; env_file .env; named volume → /data
  .env                 # 600 root:root — runtime secrets ONLY (never built into the image)
  litestream.yml       # R2 (S3-compatible) replica config; env-expanded at load
  .image / .image.prev # the currently-deployed and previous image DIGESTS (for rollback)
/etc/caddy/
  Caddyfile            # reverse_proxy 127.0.0.1:3000; Authenticated Origin Pulls (mTLS)
  cf-origin-pull-ca.pem# the Cloudflare AOP CA, trusted by Caddy's client_auth
```

`.env` keys (values runtime-only): `NODE_ENV`, `DATABASE_URL=file:/data/sheet-llm.db`,
distinct 32-byte `SESSION_SECRET` + `RECOVERY_SECRET`, `ANTHROPIC_API_KEY`,
`APP_BASE_URL=https://sheetllm.com`, `SL_FORCE_FREE_TIER=1`, `SL_REQUIRE_WAL=1`
+ `LITESTREAM_*` (R2 bucket/endpoint/keys), and the
[Turnstile](security-hardening.md#turnstile-bot-gate) `TURNSTILE_SITE_KEY` /
`TURNSTILE_SECRET_KEY`. `SL_ACCOUNTS_ENABLED` is left unset for v1.

## How a deploy happens

Deploys are **pull-based and image-digest-pinned** — see
[ci-cd-pipeline.md](ci-cd-pipeline.md) for the CI side. The server side is
`deploy/deploy.sh`, the *only* command the CI SSH key may run (forced command +
narrow sudoers; the `deploy` user is not in the `docker` group). It:

1. Accepts **only** a bare `sha256:<64 hex>` digest as `SSH_ORIGINAL_COMMAND`
   (anchored regex — no tags, no extra args, no shell metacharacters).
2. Writes the digest to `.image` (keeping `.image.prev` for rollback).
3. `SHEETLLM_IMAGE="ghcr.io/realrogerwinter/sheet-llm@<digest>" docker compose
   pull && up -d --remove-orphans`.

Because SQLite is a single writer, deploys are effectively stop-then-start on
the one app container. **Rollback** is re-running with the digest in
`.image.prev` — digests are immutable, never a moving tag.

## First-time bring-up (abbreviated)

1. Build the image locally and confirm it boots, migrates, and serves
   `/api/health` against a throwaway volume **before** wiring Caddy/Cloudflare.
2. Provision the host (see [security-hardening.md](security-hardening.md)):
   ufw, fail2ban, key-only SSH, Docker, the `deploy` user + forced command.
3. Create the R2 bucket + access keys; verify `journal_mode=WAL` sticks on the
   named volume **before** setting `LITESTREAM_REPLICA_URL` (the URL alone arms
   the refuse-to-boot durability gate).
4. Write `/opt/sheet-llm/.env` (`umask 077`, secrets generated with
   `openssl rand -base64 32`, never echoed).
5. Onboard Cloudflare (NS move, proxied A/AAAA, Full-strict, Authenticated
   Origin Pulls), build Caddy with the `caddy-dns/cloudflare` plugin, and lock
   `:80/:443` to Cloudflare IPs.
6. `docker compose up -d`; confirm `/api/health` 200 over loopback and that
   migrations applied; point DNS; verify `https://sheetllm.com` through CF.

See [durability-runbook.md](durability-runbook.md) for the Litestream restore
drill and disaster-recovery procedure.
