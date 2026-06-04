# syntax=docker/dockerfile:1

# Pin Node 22 (engines: >=20.9). The build and runtime stages MUST use the SAME
# base so the better-sqlite3 native ABI (NODE_MODULE_VERSION) matches. For
# production, pin by DIGEST via the build arg (CI sets NODE_IMAGE=node:22-...@sha256:..).
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- base (corepack/pnpm) ----------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

# ---------- build ----------
FROM base AS build
WORKDIR /app
# Toolchain for the better-sqlite3 native compile + fetching the Litestream binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*
# Litestream (downloaded here; only the binary is copied into the lean runtime).
ARG LITESTREAM_VERSION=v0.3.13
RUN wget -qO /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
  && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && rm /tmp/litestream.tar.gz \
  && /usr/local/bin/litestream version
# Deps first (cache layer); corepack pins pnpm@9.15.9 from package.json.
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile
# Build the standalone server.
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# Fail the BUILD (not a 3am runtime crash) if the native addon wasn't traced into
# the standalone output. better-sqlite3 is externalized in next.config.ts.
RUN node -e "require('node:fs').accessSync('.next/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node')" \
  || ( echo 'FATAL: better-sqlite3 native addon missing from .next/standalone' >&2; \
       find .next/standalone -name 'better_sqlite3.node' 2>/dev/null; exit 1 )

# ---------- runtime (lean) ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# tini: PID1 signal forwarding + zombie reaping (so SIGTERM reaches node through
# Litestream on `compose down`). gosu: drop root after chowning the data volume.
# ca-certificates: TLS to Anthropic / R2.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini gosu ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/litestream /usr/local/bin/litestream
RUN groupadd --system app && useradd --system --gid app --create-home --home-dir /home/app app
# Standalone server + static + public + migrations. drizzle/ is COPYed EXPLICITLY
# (not just traced) because the boot gate FATALs if it's absent.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
# Liveness via the bundled node runtime (slim has no curl/wget).
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini = PID1. The entrypoint starts as ROOT only to chown /data, then drops to
# 'app' (gosu) to run Litestream -> node server.js.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
