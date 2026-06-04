---
title: Host Monitoring & Alerting
subsystem: ops
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: 9da3a60
source_paths:
  - deploy/monitoring/run-all.sh
  - deploy/monitoring/install.sh
  - deploy/monitoring/lib/common.sh
  - deploy/monitoring/checks
  - deploy/monitoring/systemd/sheetllm-monitor.timer
related:
  - deploy-vps
  - security-hardening
  - durability-runbook
---

# Host Monitoring & Alerting

A small, dependency-free monitoring suite that runs on the VPS itself: five
checks behind one systemd timer, alerting over email (reusing the app's SMTP
relay) and/or a webhook. It catches the failure modes that would otherwise go
silent — the app dying, replication breaking, the disk filling, the
Authenticated-Origin-Pulls cert expiring, or the Cloudflare-IP firewall refresh
going stale. Lives in [`deploy/monitoring/`](../../deploy/monitoring).

## What it checks (`deploy/monitoring/checks/`)

| Check | Passes when | Why it matters |
| --- | --- | --- |
| `health` | app returns `200` on `127.0.0.1:3000/api/health` **and** `caddy` is active | the container or reverse proxy is down |
| `litestream` | container running, a `litestream` process is alive (`docker top`), no replication `ERROR` in the last `LITESTREAM_LOG_WINDOW` | R2 replication silently stopped → no durable backups |
| `disk` | every path in `DISK_PATHS` is under `DISK_PCT_MAX` (85%) | a full disk breaks SQLite writes + the WAL |
| `aop-cert` | the CF origin-pull CA at `AOP_CERT_PATH` has > `AOP_MIN_DAYS` (21) left | expiry = **100% origin outage** (mTLS handshake fails for all CF traffic) |
| `cf-ufw` | `cf-ufw-refresh` timer exists, is enabled+active, and any *known* last run is within `CFUFW_MAX_AGE_DAYS` (8) | the origin CF-IP allow-list drifts / stops being maintained |

> **Note on "lag":** `litestream` checks for replication *errors*, not raw time
> lag — Litestream only writes a WAL segment when the DB changes, so an idle
> period is healthy, not stale.

> **External probe:** the origin can't probe `https://sheetllm.com/api/health`
> through Cloudflare (the CF-IP firewall + hairpin block it), so `health` checks
> loopback. Pair it with an **off-host uptime monitor** (e.g. a free UptimeRobot
> hitting `https://sheetllm.com/api/health`) to catch full-host/network loss.

## How it runs

`sheetllm-monitor.timer` fires `run-all.sh` every 10 minutes (a single cadence;
the cheap checks tolerate it, and per-check alert throttling in `lib/common.sh`
prevents spam). Each check self-alerts on failure and emits a one-shot recovery
notice when it passes again. `run-all.sh` exits non-zero if any check failed, so
`systemctl status sheetllm-monitor` and the journal also reflect failures.

## Alerting

`lib/common.sh` `alert()` is throttled per check (default `MONITOR_THROTTLE_SEC`
= 6h) and delivers to whichever channels are configured:

- **Email** — set `MONITOR_ALERT_EMAIL` plus `SMTP_*` (copy from
  `/opt/sheet-llm/.env`; the same Brevo relay the app uses).
- **Webhook** — set `MONITOR_WEBHOOK_URL` (Slack/Discord/generic JSON; sent in
  addition to email).

The config is **parsed as `KEY=VALUE`** (not `source`-d), so values with spaces
or `<>` (e.g. `EMAIL_FROM`) work without quoting and the file can never execute
code.

## Install (on the VPS, as root)

```bash
sudo deploy/monitoring/install.sh
# → copies checks to /opt/sheetllm-monitoring, seeds /etc/sheetllm-monitoring.env
#   (0600), installs + enables sheetllm-monitor.timer

sudoedit /etc/sheetllm-monitoring.env     # set MONITOR_ALERT_EMAIL + SMTP_* (or MONITOR_WEBHOOK_URL)

# run once now + watch:
sudo systemctl start sheetllm-monitor.service
journalctl -u sheetllm-monitor -n 40 --no-pager
systemctl list-timers sheetllm-monitor.timer
```

All knobs and their defaults are documented in
[`sheetllm-monitoring.env.example`](../../deploy/monitoring/sheetllm-monitoring.env.example).
Re-running `install.sh` is idempotent and never overwrites an existing config.
