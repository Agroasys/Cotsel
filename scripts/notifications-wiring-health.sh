#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"
COMPOSE_FILE="docker-compose.services.yml"

usage() {
  echo "Usage: scripts/notifications-wiring-health.sh <local-dev|staging-e2e-real>" >&2
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

require_compose_mapping() {
  local expected="$1"
  if ! grep -Fq "$expected" "$COMPOSE_FILE"; then
    echo "missing compose notifications mapping: $expected" >&2
    return 1
  fi
  return 0
}

require_boolean() {
  local name="$1"
  local value="$2"
  if [[ "$value" != "true" && "$value" != "false" ]]; then
    echo "$name must be true or false (received: $value)" >&2
    return 1
  fi
  return 0
}

require_non_negative_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer (received: $value)" >&2
    return 1
  fi
  return 0
}

require_timeout_milliseconds() {
  local name="$1"
  local value="$2"

  if ! require_non_negative_integer "$name" "$value"; then
    return 1
  fi

  if (( value < 1000 )); then
    echo "$name must be >= 1000 (received: $value)" >&2
    return 1
  fi

  return 0
}

load_env_file ".env"
load_env_file "$PROFILE_FILE"

oracle_enabled="${ORACLE_NOTIFICATIONS_ENABLED:-false}"
oracle_webhook="${ORACLE_NOTIFICATIONS_WEBHOOK_URL:-}"
oracle_cooldown="${ORACLE_NOTIFICATIONS_COOLDOWN_MS:-300000}"
oracle_timeout="${ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS:-5000}"

reconciliation_enabled="${RECONCILIATION_NOTIFICATIONS_ENABLED:-false}"
reconciliation_webhook="${RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL:-}"
reconciliation_cooldown="${RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS:-300000}"
reconciliation_timeout="${RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS:-5000}"

require_compose_mapping 'NOTIFICATIONS_ENABLED: "${ORACLE_NOTIFICATIONS_ENABLED}"'
require_compose_mapping 'NOTIFICATIONS_WEBHOOK_URL: "${ORACLE_NOTIFICATIONS_WEBHOOK_URL}"'
require_compose_mapping 'NOTIFICATIONS_COOLDOWN_MS: "${ORACLE_NOTIFICATIONS_COOLDOWN_MS}"'
require_compose_mapping 'NOTIFICATIONS_REQUEST_TIMEOUT_MS: "${ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS}"'

require_compose_mapping 'NOTIFICATIONS_ENABLED: "${RECONCILIATION_NOTIFICATIONS_ENABLED}"'
require_compose_mapping 'NOTIFICATIONS_WEBHOOK_URL: "${RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL}"'
require_compose_mapping 'NOTIFICATIONS_COOLDOWN_MS: "${RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS}"'
require_compose_mapping 'NOTIFICATIONS_REQUEST_TIMEOUT_MS: "${RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS}"'

require_boolean "ORACLE_NOTIFICATIONS_ENABLED" "$oracle_enabled"
require_boolean "RECONCILIATION_NOTIFICATIONS_ENABLED" "$reconciliation_enabled"

if [[ "$oracle_enabled" == "true" && -z "$oracle_webhook" ]]; then
  echo "ORACLE_NOTIFICATIONS_WEBHOOK_URL is required when ORACLE_NOTIFICATIONS_ENABLED=true" >&2
  exit 1
fi

if [[ "$reconciliation_enabled" == "true" && -z "$reconciliation_webhook" ]]; then
  echo "RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL is required when RECONCILIATION_NOTIFICATIONS_ENABLED=true" >&2
  exit 1
fi

require_non_negative_integer "ORACLE_NOTIFICATIONS_COOLDOWN_MS" "$oracle_cooldown"
require_timeout_milliseconds "ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS" "$oracle_timeout"

require_non_negative_integer "RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS" "$reconciliation_cooldown"
require_timeout_milliseconds "RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS" "$reconciliation_timeout"

echo "notifications wiring health: profile=$PROFILE oracleEnabled=$oracle_enabled reconciliationEnabled=$reconciliation_enabled"
