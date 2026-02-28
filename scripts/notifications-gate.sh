#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"

usage() {
  echo "Usage: scripts/notifications-gate.sh <local-dev|staging-e2e-real>" >&2
}

if [[ -z "$PROFILE" ]]; then
  usage
  exit 1
fi

case "$PROFILE" in
  local-dev)
    PROFILE_FILE=".env.local"
    ;;
  staging-e2e-real)
    PROFILE_FILE=".env.staging-e2e-real"
    ;;
  *)
    echo "Unsupported profile: $PROFILE" >&2
    usage
    exit 1
    ;;
esac

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file ".env"
load_env_file "$PROFILE_FILE"

scripts/notifications-wiring-health.sh "$PROFILE"

if [[ ! -f "notifications/dist/index.js" ]]; then
  echo "Missing notifications build output (notifications/dist/index.js). Run: npm run -w notifications build" >&2
  exit 1
fi

REPORT_DIR="${NOTIFICATIONS_GATE_REPORT_DIR:-reports/notifications}"
REPORT_FILE="${REPORT_DIR}/${PROFILE}.json"

export NOTIFICATIONS_GATE_PROFILE="$PROFILE"
export NOTIFICATIONS_GATE_OUT_FILE="$REPORT_FILE"

export ORACLE_NOTIFICATIONS_COOLDOWN_MS="${ORACLE_NOTIFICATIONS_COOLDOWN_MS:-300000}"
export ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS="${ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS:-5000}"
export RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS="${RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS:-300000}"
export RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS="${RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS:-5000}"

echo "Running notifications gate: profile=${PROFILE} report=${REPORT_FILE}"
node scripts/notifications-gate-validate.mjs
