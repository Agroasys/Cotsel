#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.services.yml"

extract_service_block() {
  local service_name="$1"
  awk -v service_name="$service_name" '
    $0 == "  " service_name ":" { in_block=1; print; next }
    in_block && $0 ~ /^  [^[:space:]].*:/ { exit }
    in_block { print }
  ' "$COMPOSE_FILE"
}

assert_block_contains() {
  local block="$1"
  local needle="$2"
  local message="$3"

  if ! grep -Fq "$needle" <<<"$block"; then
    echo "$message" >&2
    echo "$block" >&2
    exit 1
  fi
}

treasury_block="$(extract_service_block treasury)"
oracle_block="$(extract_service_block oracle)"

assert_block_contains \
  "$treasury_block" \
  "RATE_LIMIT_ENABLED: '\${TREASURY_RATE_LIMIT_ENABLED}'" \
  "expected treasury compose block to wire TREASURY_RATE_LIMIT_ENABLED into RATE_LIMIT_ENABLED"
assert_block_contains \
  "$treasury_block" \
  "RATE_LIMIT_REDIS_URL: '\${TREASURY_RATE_LIMIT_REDIS_URL}'" \
  "expected treasury compose block to wire TREASURY_RATE_LIMIT_REDIS_URL into RATE_LIMIT_REDIS_URL"
assert_block_contains \
  "$treasury_block" \
  "redis:" \
  "expected treasury compose block to depend on redis readiness"
assert_block_contains \
  "$treasury_block" \
  "condition: service_healthy" \
  "expected treasury compose block to wait for redis health"

assert_block_contains \
  "$oracle_block" \
  "ORACLE_RATE_LIMIT_ENABLED: '\${ORACLE_RATE_LIMIT_ENABLED}'" \
  "expected oracle compose block to wire ORACLE_RATE_LIMIT_ENABLED"
assert_block_contains \
  "$oracle_block" \
  "ORACLE_RATE_LIMIT_REDIS_URL: '\${ORACLE_RATE_LIMIT_REDIS_URL}'" \
  "expected oracle compose block to wire ORACLE_RATE_LIMIT_REDIS_URL"
assert_block_contains \
  "$oracle_block" \
  "redis:" \
  "expected oracle compose block to depend on redis readiness"
assert_block_contains \
  "$oracle_block" \
  "condition: service_healthy" \
  "expected oracle compose block to wait for redis health"

echo "docker-services compose rate-limit wiring: pass"
