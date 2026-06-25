#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/notifications-wiring-health.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp "$SCRIPT" "$tmp_dir/notifications-wiring-health.sh"
cp "$ROOT_DIR/docker-compose.services.yml" "$tmp_dir/docker-compose.services.yml"
chmod +x "$tmp_dir/notifications-wiring-health.sh"

# Notifications disabled: wiring health should pass.
cat > "$tmp_dir/.env.runtime" <<'ENV'
ORACLE_NOTIFICATIONS_ENABLED=false
ORACLE_NOTIFICATIONS_WEBHOOK_URL=
ORACLE_NOTIFICATIONS_COOLDOWN_MS=300000
ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
RECONCILIATION_NOTIFICATIONS_ENABLED=false
RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL=
RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS=300000
RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
ENV

(
  cd "$tmp_dir"
  ./notifications-wiring-health.sh runtime >/dev/null
)

# Enable notifications without a webhook URL and expect failure.
cat > "$tmp_dir/.env.runtime" <<'ENV'
ORACLE_NOTIFICATIONS_ENABLED=true
ORACLE_NOTIFICATIONS_WEBHOOK_URL=
ORACLE_NOTIFICATIONS_COOLDOWN_MS=300000
ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
RECONCILIATION_NOTIFICATIONS_ENABLED=false
RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL=
RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS=300000
RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
ENV

if (
  cd "$tmp_dir"
  ./notifications-wiring-health.sh runtime >/dev/null 2>&1
); then
  echo "expected runtime wiring health to fail when webhook is missing and enabled" >&2
  exit 1
fi

# Enable notifications with webhook URLs: wiring health should pass.
cat > "$tmp_dir/.env.runtime" <<'ENV'
ORACLE_NOTIFICATIONS_ENABLED=true
ORACLE_NOTIFICATIONS_WEBHOOK_URL=https://hooks.example.invalid/oracle
ORACLE_NOTIFICATIONS_COOLDOWN_MS=300000
ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
RECONCILIATION_NOTIFICATIONS_ENABLED=true
RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL=https://hooks.example.invalid/reconciliation
RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS=300000
RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS=5000
ENV

(
  cd "$tmp_dir"
  ./notifications-wiring-health.sh runtime >/dev/null
)

echo "notifications wiring health validation: pass"
