---
title: Security Hardening & Threat Model
subsystem: ops
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 4453d42
source_paths:
  - src/lib/security/turnstile.ts
  - src/lib/http/clientIp.ts
  - src/lib/orchestrator/requestRateLimit.ts
  - src/app/api/chat/route.ts
  - src/app/api/turnstile/route.ts
  - next.config.ts
related:
  - deploy-vps
  - ci-cd-pipeline
---

# Security Hardening & Threat Model

The production posture is **security-first** and **defense-in-depth**: every
control assumes the layer in front of it can fail. The two primary risks are
(1) LLM cost-abuse — automated clients burning Anthropic tokens — and (2)
direct origin exposure bypassing Cloudflare. This guide documents the layers
defending against both, from the network edge inward to the application.

## Origin lock (network edge)

The origin (the VPS) must only ever be reached *through* Cloudflare. Two
independent controls enforce this:

- **ufw IP allow-list.** Inbound `:80/:443` is `ALLOW` only from Cloudflare's
  published IP ranges (v4 and v6); the default policy is `deny (incoming)`. A
  systemd timer (`cf-ufw-refresh.timer`) refreshes the ranges. SSH (`:22`) is
  open (key-only). The app port `:3000` is never published — the container
  binds `127.0.0.1:3000` (loopback) only.
- **Authenticated Origin Pulls (mTLS).** Caddy is configured with
  `client_auth { mode require_and_verify; trust_pool { file
  cf-origin-pull-ca.pem } }`. A TLS client that does not present Cloudflare's
  origin-pull certificate is refused at the handshake — so even a request from
  a Cloudflare IP that isn't the real CF proxy cannot reach the app.

These are complementary: the firewall blocks non-CF *source IPs*; AOP blocks
non-CF *clients* regardless of IP. Verified live: connecting to the origin
`:443` without the CF client certificate is refused with a TLS handshake alert,
and `:3000` is unreachable off-host.

> A true external port scan must be run from an off-host vantage
> (`nmap -Pn -p 22,80,443,3000 <origin-ip>`): expect `22` open, `3000` closed,
> and `80/443` reachable only via Cloudflare. Scanning from the origin itself
> hairpins to local Caddy and is not representative.

## Host hardening

- **SSH:** password and keyboard-interactive auth disabled
  (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`),
  `AuthenticationMethods publickey`, `PermitRootLogin prohibit-password`,
  `AllowUsers` allow-list, `MaxAuthTries 3`. The hardening drop-in is ordered
  to win over cloud-init's (`sshd` is first-match-wins). SSH is socket-activated
  (`ssh.socket`), so it returns after reboot.
- **fail2ban** with the systemd backend (Ubuntu has no `/var/log/auth.log`),
  sshd jail enabled.
- **Unattended upgrades** with automatic reboot at a low-traffic window.
- **sysctl** hardening (rp_filter, syncookies, no redirects/source-route);
  `ip_forward` is left enabled because Docker needs it.
- **Least-privilege deploy.** The `deploy` user is **not** in the `docker`
  group; its SSH key is restricted to a forced command
  (`command="sudo -n /usr/local/bin/deploy.sh",restrict`) and sudoers permits
  *only* that one script. See [ci-cd-pipeline.md](ci-cd-pipeline.md).

## Secret hygiene

- The Docker image contains **no secrets** — no `.env`, no `.git`, no keys; the
  baked `ENV` is only `NODE_ENV/PORT/HOSTNAME/…`. Secrets are injected at
  *runtime* from the host `.env` (`600 root:root`); `/proc/<pid>/environ` is
  `400 root`. CI build passes no secret `--build-arg`.
- No `NEXT_PUBLIC_*` carries a secret. The Turnstile **site** key (public by
  design) is read server-side and passed as a prop, never build-time inlined;
  the **secret** key stays server-side.

## Application-layer abuse controls (LLM cost defense)

The token-burning routes (`/api/chat`, `/api/import`) are gated by three
layers, each independent of Cloudflare's edge controls:

### Correct client-IP attribution

`src/lib/http/clientIp.ts` `extractClientIp()` reads **`CF-Connecting-IP`
first** (unspoofable past Cloudflare, hop-count independent), falling back to a
hop-aware `X-Forwarded-For` pinned by `TRUSTED_PROXY_HOPS`. This defeats
leftmost-XFF spoofing: a client-supplied `X-Forwarded-For` cannot move a request
into another IP's bucket while behind Cloudflare.

### Per-IP rate limiting

`src/lib/orchestrator/requestRateLimit.ts` `checkRequestIp(ip)` is a per-IP
sliding window applied to the cost routes (returns `429 rate_limited` with a
`retryAfterSec`). The internal maps are bounded with max-entry eviction so a
flood of distinct IPs cannot exhaust memory.

### Turnstile bot-gate

`src/lib/security/turnstile.ts` implements a Cloudflare Turnstile gate. A client
solves the managed-mode challenge once; `POST /api/turnstile` verifies the token
with Cloudflare's `siteverify`, and on success issues a short-lived
(`30 min`), **IP-bound, HMAC-signed** clearance cookie. The cost routes call
`hasClearance(request)` and return `403 bot_check_required` without it.

Key properties:

- **Fail-open when unconfigured.** Gating is active only when *both*
  `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set (`isTurnstileEnabled()`);
  otherwise `hasClearance` returns `true` and the widget renders nothing — so
  dev/test/stub and any non-Turnstile deploy behave exactly as before.
- **No new secret.** The clearance cookie is an HMAC over `SESSION_SECRET`
  (domain-separated with a `turnstile-clear:` prefix), compared with
  `crypto.timingSafeEqual`.
- **Replay-resistant.** The cookie binds the issuing IP (from `CF-Connecting-IP`)
  and an expiry into the signed payload, so a token solved by one client cannot
  be reused across a botnet.

### Request integrity

Mutating routes enforce **strict same-origin** (`checkSameOrigin` →
`403 invalid_request` on cross-origin or a bad `Origin`). Response security
headers + HSTS are set in `next.config.ts` (and must not be duplicated by
Caddy/Cloudflare).

### Backstops (not in code)

- A Cloudflare edge rate-limit rule on `/api/chat` and `/api/auth/*`, plus Bot
  Fight Mode.
- An **Anthropic organisation spend cap** — the final, provider-side ceiling on
  cost-abuse. This must be set in the Anthropic dashboard; it is not enforceable
  from this repo.

## Layered summary

| Threat | Controls (outer → inner) |
| --- | --- |
| Direct origin access | CF proxy → ufw CF-IP allow-list → AOP mTLS → app on loopback |
| Bot token-burning | Bot Fight Mode → edge rate-limit → Turnstile clearance → per-IP rate limit → free-tier cap → Anthropic spend cap |
| Spoofed identity | `CF-Connecting-IP` attribution → strict same-origin → IP-bound HMAC clearance |
| Host compromise | key-only SSH + fail2ban → least-priv `deploy` (forced command, no docker group) → no secrets in image |
