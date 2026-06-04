#!/usr/bin/env bash
# Server-side deploy script — the ONLY thing the CI deploy SSH key may run.
#
# Wiring on the VPS (least-privilege; the `deploy` user is NOT in the docker group):
#   sudo install -m 0755 deploy.sh /usr/local/bin/deploy.sh   # root-owned
#   # sudoers: let `deploy` run ONLY this script as root, no password:
#   echo 'deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy.sh' \
#     | sudo install -m 0440 /dev/stdin /etc/sudoers.d/deploy
#   # ~deploy/.ssh/authorized_keys — force this command, lock the key down:
#   command="sudo -n /usr/local/bin/deploy.sh",restrict <ci-deploy-public-key>
#
# CI sends only the image digest as SSH_ORIGINAL_COMMAND; everything else is fixed.
set -euo pipefail

REPO="ghcr.io/realrogerwinter/sheet-llm"
APPDIR="/opt/sheet-llm"
REF="${SSH_ORIGINAL_COMMAND:-}"

# Accept ONLY a bare digest — anchored, hex-only — so no shell metacharacters,
# no arbitrary image, no extra args can be smuggled in.
if [[ ! "$REF" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "deploy refused: expected 'sha256:<64 hex>', got: '${REF}'" >&2
  exit 1
fi

IMAGE="${REPO}@${REF}"
cd "$APPDIR"

# Persist the digest for an atomic rollback (keep the previous one).
[ -f .image ] && cp -f .image .image.prev || true
printf '%s\n' "$IMAGE" > .image
logger -t sheetllm-deploy "deploying ${IMAGE}"

# compose substitutes ${SHEETLLM_IMAGE}; container env still comes from .env.
SHEETLLM_IMAGE="$IMAGE" docker compose pull
SHEETLLM_IMAGE="$IMAGE" docker compose up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "deployed ${IMAGE}"
# Rollback: re-run with the digest from .image.prev (kept pinned, never a moving tag).
