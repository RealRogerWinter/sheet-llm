# shellcheck shell=bash
# Shared helpers for the sheet-llm host monitoring checks. Sourced by every
# script in ../checks/. Provides config loading, logging, and a throttled
# alert() that delivers over email (SMTP) and/or a webhook.
#
# Config lives in $SHEETLLM_MON_ENV (default /etc/sheetllm-monitoring.env, 600,
# root-owned). See sheetllm-monitoring.env.example for every knob.

SHEETLLM_MON_ENV="${SHEETLLM_MON_ENV:-/etc/sheetllm-monitoring.env}"
# Parse the config as KEY=VALUE lines (docker-env-file semantics) rather than
# `source`-ing it: values may contain spaces / < > (e.g. EMAIL_FROM) which would
# break shell parsing, and a config file should never execute code.
if [ -f "$SHEETLLM_MON_ENV" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line%$'\r'}"
    case "$_line" in ''|'#'*) continue ;; esac
    _key="${_line%%=*}"
    _val="${_line#*=}"
    _key="${_key#"${_key%%[![:space:]]*}"}"   # ltrim key
    case "$_key" in [A-Za-z_]*) ;; *) continue ;; esac
    case "$_val" in
      '"'*'"') _val="${_val#\"}"; _val="${_val%\"}" ;;
      "'"*"'") _val="${_val#\'}"; _val="${_val%\'}" ;;
    esac
    export "$_key=$_val"
  done < "$SHEETLLM_MON_ENV"
  unset _line _key _val
fi

# Defaults — override any of these in the env file.
: "${MONITOR_STATE_DIR:=/var/lib/sheetllm-monitoring}"
: "${MONITOR_THROTTLE_SEC:=21600}"          # re-alert at most every 6h per check
: "${HEALTH_LOOPBACK_URL:=http://127.0.0.1:3000/api/health}"
: "${APP_CONTAINER:=sheet-llm-app-1}"
: "${CADDY_SERVICE:=caddy}"
: "${DISK_PATHS:=/ /var/lib/docker}"
: "${DISK_PCT_MAX:=85}"
: "${LITESTREAM_LOG_WINDOW:=15m}"
: "${AOP_CERT_PATH:=/etc/caddy/cf-origin-pull-ca.pem}"
: "${AOP_MIN_DAYS:=21}"
: "${CFUFW_SERVICE:=cf-ufw-refresh}"
: "${CFUFW_MAX_AGE_DAYS:=8}"

log() {
  logger -t "sheetllm-mon[${CHECK_NAME:-?}]" -- "$*" 2>/dev/null || true
  printf '[%s] %s\n' "${CHECK_NAME:-?}" "$*" >&2
}

# _send SUBJECT BODY — best-effort delivery over whatever channels are set.
_send() {
  local subject="$1" body="$2" delivered=0
  if [ -n "${MONITOR_WEBHOOK_URL:-}" ]; then
    SUBJECT="$subject" BODY="$body" python3 - "$MONITOR_WEBHOOK_URL" <<'PY' 2>/dev/null && delivered=1 || log "webhook notify failed"
import json, os, sys, urllib.request
text = os.environ["SUBJECT"] + "\n\n" + os.environ["BODY"]
# {"text":...} suits Slack; {"content":...} suits Discord — send both keys.
data = json.dumps({"text": text, "content": text}).encode()
req = urllib.request.Request(sys.argv[1], data=data, headers={"content-type": "application/json"})
urllib.request.urlopen(req, timeout=15).read()
PY
  fi
  if [ -n "${MONITOR_ALERT_EMAIL:-}" ] && [ -n "${SMTP_HOST:-}" ] && [ -n "${SMTP_USER:-}" ] && [ -n "${SMTP_PASS:-}" ]; then
    SUBJECT="$subject" BODY="$body" TO="$MONITOR_ALERT_EMAIL" python3 - <<'PY' 2>/dev/null && delivered=1 || log "email notify failed"
import os, smtplib, ssl
from email.message import EmailMessage
m = EmailMessage()
m["From"] = os.environ.get("EMAIL_FROM") or os.environ["SMTP_USER"]
m["To"] = os.environ["TO"]
m["Subject"] = os.environ["SUBJECT"]
m.set_content(os.environ["BODY"])
port = int(os.environ.get("SMTP_PORT", "587"))
with smtplib.SMTP(os.environ["SMTP_HOST"], port, timeout=20) as s:
    if os.environ.get("SMTP_SECURE") != "1" and port != 465:
        s.starttls(context=ssl.create_default_context())
    s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
    s.send_message(m)
PY
  fi
  [ "$delivered" = 1 ] || log "NO alert channel delivered (set MONITOR_ALERT_EMAIL+SMTP_* or MONITOR_WEBHOOK_URL)"
}

# alert MESSAGE — emit an alert, throttled to once per MONITOR_THROTTLE_SEC per
# check so a persistent failure doesn't spam. Always logs.
alert() {
  local msg="$1" now stamp last
  now="$(date +%s)"
  mkdir -p "$MONITOR_STATE_DIR" 2>/dev/null || true
  stamp="$MONITOR_STATE_DIR/${CHECK_NAME}.last-alert"
  if [ -f "$stamp" ]; then
    last="$(cat "$stamp" 2>/dev/null || echo 0)"
    if [ $(( now - last )) -lt "$MONITOR_THROTTLE_SEC" ]; then
      log "ALERT (throttled): $msg"
      return 0
    fi
  fi
  log "ALERT: $msg"
  _send "[sheet-llm] ${CHECK_NAME} on $(hostname)" "$msg"
  echo "$now" > "$stamp" 2>/dev/null || true
}

# clear_alert — call on a passing check so the next failure alerts immediately
# (and emit a one-shot recovery notice if we were previously alerting).
clear_alert() {
  local stamp="$MONITOR_STATE_DIR/${CHECK_NAME}.last-alert"
  if [ -f "$stamp" ]; then
    _send "[sheet-llm] ${CHECK_NAME} RECOVERED on $(hostname)" "Check ${CHECK_NAME} is healthy again."
    rm -f "$stamp" 2>/dev/null || true
  fi
}
