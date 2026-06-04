#!/usr/bin/env bash
# Install the sheet-llm host monitoring suite. Idempotent; run as root on the VPS:
#   sudo deploy/monitoring/install.sh
#
# Copies the checks to /opt/sheetllm-monitoring, installs the systemd timer, and
# seeds /etc/sheetllm-monitoring.env from the example (edit it to set an alert
# channel). Does NOT overwrite an existing config.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/sheetllm-monitoring
ENV_FILE=/etc/sheetllm-monitoring.env

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

echo "Installing checks → $DEST"
mkdir -p "$DEST"
cp -a "$SRC/lib" "$SRC/checks" "$SRC/run-all.sh" "$DEST/"
chmod 0755 "$DEST/run-all.sh" "$DEST"/checks/*.sh
mkdir -p /var/lib/sheetllm-monitoring

if [ ! -f "$ENV_FILE" ]; then
  install -m 0600 "$SRC/sheetllm-monitoring.env.example" "$ENV_FILE"
  echo "Seeded $ENV_FILE (0600) — EDIT IT: set MONITOR_ALERT_EMAIL + SMTP_* (copy from /opt/sheet-llm/.env) or MONITOR_WEBHOOK_URL"
else
  echo "Keeping existing $ENV_FILE"
fi

echo "Installing systemd units"
install -m 0644 "$SRC/systemd/sheetllm-monitor.service" /etc/systemd/system/
install -m 0644 "$SRC/systemd/sheetllm-monitor.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sheetllm-monitor.timer

echo "Done. Run once now:  systemctl start sheetllm-monitor.service && journalctl -u sheetllm-monitor -n 40 --no-pager"
echo "Next runs:           systemctl list-timers sheetllm-monitor.timer"
