#!/usr/bin/env bash
#
# Install chunk-cli for this repo's inner-loop sidecar validation.
#
#   macOS      : Homebrew tap (falls back to the prebuilt tarball).
#   Linux/WSL  : prebuilt tarball -> ~/.local/bin.
#   Windows    : run this INSIDE WSL ->  wsl bash scripts/chunk/bootstrap.sh
#
# After install, authenticate once (token from
# https://app.circleci.com/settings/user/tokens):
#   export CIRCLE_TOKEN=...  CIRCLECI_ORG_ID=...
# and the committed agent hooks (.claude/settings.json) will run `chunk validate`
# on a CircleCI sidecar at the end of every turn. See docs/guides/chunk-sidecars.md.
set -euo pipefail

CHUNK_VERSION="${CHUNK_VERSION:-v0.7.73}"
have() { command -v "$1" >/dev/null 2>&1; }

if have chunk; then
  echo "chunk already installed: $(chunk --version)"
  exit 0
fi

os="$(uname -s)"
arch="$(uname -m)"
[ "$arch" = "aarch64" ] && arch="arm64"

case "$os" in
  Darwin)
    if have brew; then
      brew install CircleCI-Public/circleci/chunk
      exit 0
    fi
    asset="chunk-cli_Darwin_${arch}.tar.gz"
    ;;
  Linux)
    asset="chunk-cli_Linux_${arch}.tar.gz"
    ;;
  *)
    echo "Unsupported OS '$os'. On Windows, run this inside WSL:" >&2
    echo "  wsl bash scripts/chunk/bootstrap.sh" >&2
    exit 1
    ;;
esac

url="https://github.com/CircleCI-Public/chunk-cli/releases/download/${CHUNK_VERSION}/${asset}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${url}"
curl -fsSL "$url" -o "$tmp/chunk.tgz"
tar -xzf "$tmp/chunk.tgz" -C "$tmp"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$(find "$tmp" -maxdepth 2 -type f -name chunk | head -n1)" "$HOME/.local/bin/chunk"
echo "Installed chunk -> $HOME/.local/bin/chunk ($("$HOME/.local/bin/chunk" --version))"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "NOTE: add ~/.local/bin to your PATH (most login shells already do)." ;;
esac

# Best-effort: provision a NATIVE pnpm in this Linux/WSL env via corepack, so the
# commit-gate's `pnpm typecheck` uses it instead of falling through to a Windows
# pnpm shim on /mnt/c (which WSL exposes via interop). Harmless if already set up.
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@9.15.9 --activate >/dev/null 2>&1 || true
fi

cat <<'EOF'

Next steps:
  1. Create a CircleCI API token: https://app.circleci.com/settings/user/tokens
  2. export CIRCLE_TOKEN=<token>  CIRCLECI_ORG_ID=<org-id>
  3. chunk validate --list      # sanity-check the configured gates
EOF
