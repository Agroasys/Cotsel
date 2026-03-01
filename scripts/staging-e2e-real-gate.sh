#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.services.yml"
PROFILE="staging-e2e-real"
failures=0

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

# Normalize URLs that use Docker's internal hostname so they work from the host,
# by converting host.docker.internal to 127.0.0.1 for host-side access.
normalize_host_url() {
  local url="$1"
  echo "${url//host.docker.internal/127.0.0.1}"
}

get_rpc_head_hex() {
  local rpc_head_hex=""
  if [[ -n "${RPC_GATEWAY_URL_HOST:-}" ]]; then
    rpc_head_hex="$(
      curl -fsS "${RPC_GATEWAY_URL_HOST}" \
        -H 'content-type: application/json' \
        --data '{"id":1,"jsonrpc":"2.0","method":"eth_blockNumber","params":[]}' \
        | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p' \
        | head -n1 || true
    )"
  fi
  printf '%s\n' "$rpc_head_hex"
}

get_indexer_head_from_db() {
  run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" -Atc "SELECT COALESCE(MAX(block_number), 0) FROM trade_event;"
}

run_compose() {
  docker compose -f "$COMPOSE_FILE" --profile "$PROFILE" "$@"
}

pass() {
  echo "[PASS] $1"
}

fail() {
  echo "[FAIL] $1" >&2
  failures=$((failures + 1))
}

require_python3() {
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 is required for JSON helpers but was not found in PATH. Install python3 or adjust PATH."
    exit 1
  fi
}

retry_cmd() {
  local label="$1"
  local attempts="$2"
  local delay="$3"
  shift 3

  local attempt=1
  while (( attempt <= attempts )); do
    if "$@"; then
      return 0
    fi

    if (( attempt == attempts )); then
      echo "$label failed after ${attempts} attempt(s)" >&2
      return 1
    fi

    sleep "$delay"
    attempt=$((attempt + 1))
  done

  return 1
}

resolve_reconciliation_report_version() {
  if [[ -n "${RECONCILIATION_REPORT_VERSION:-}" ]]; then
    printf '%s\n' "$RECONCILIATION_REPORT_VERSION"
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local version_source="${script_dir}/../reconciliation/src/core/reconciliationReport.ts"
  local version_resolver="${script_dir}/get-reconciliation-report-version.mjs"

  if [[ -f "$version_source" && -f "$version_resolver" ]] && command -v node >/dev/null 2>&1; then
    local version
    version="$(node "$version_resolver" "$version_source" 2>/dev/null || true)"

    if [[ -n "$version" ]]; then
      printf '%s\n' "$version"
      return 0
    fi
  fi

  printf '%s\n' "1.0"
}

require_integer_digits() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    fail "$name must be an integer consisting only of digits 0-9 (received: $value)"
  fi

  # Validation errors are accumulated via the global failures counter.
  # Always return success so the gate can report all validation failures at once.
  return 0
}

json_encode_string() {
  require_python3
  python3 -c 'import json,sys; data=sys.stdin.read().rstrip("\n"); print(json.dumps(data))'
}

build_graphql_payload() {
  local query="$1"
  local encoded_query
  encoded_query="$(printf '%s' "$query" | json_encode_string)"
  printf '{"query":%s}' "$encoded_query"
}

run_graphql_query() {
  local query="$1"
  local payload
  payload="$(build_graphql_payload "$query")"
  curl -fsS "${INDEXER_GATEWAY_URL_HOST}" \
    -H 'content-type: application/json' \
    --data "$payload"
}

run_graphql_query_from_reconciliation() {
  local query="$1"
  local payload
  payload="$(build_graphql_payload "$query")"

  run_compose exec -T reconciliation node -e "
    const target = process.env.INDEXER_GRAPHQL_URL;
    if (!target) {
      console.error(
        'INDEXER_GRAPHQL_URL is not set. ' +
          'Configure INDEXER_GRAPHQL_URL for the reconciliation service (for example in docker-compose.services.yml or a .env file) ' +
          'as the full HTTP(S) URL of the indexer GraphQL endpoint, such as https://your-indexer-host/graphql.'
      );
      process.exit(1);
    }
    fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: process.argv[1],
    })
      .then((response) => process.exit(response.ok ? 0 : 1))
      .catch((err) => {
        console.error('Error while executing GraphQL request:', err);
        process.exit(1);
      });
  " "$payload"
}

extract_indexer_head_height() {
  require_python3
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception as e:
    print(f"Note: JSON parsing failed, treating indexer head height as unavailable and continuing. Details: {e}", file=sys.stderr)
    sys.exit(0)
root = data.get("data") if isinstance(data, dict) else None
squid_status = root.get("squidStatus") if isinstance(root, dict) else None
height = squid_status.get("height") if isinstance(squid_status, dict) else None
if height is not None:
    sys.stdout.write(str(height))'
}

read_indexer_head() {
  local status_response
  status_response="$(run_graphql_query '{ squidStatus { height } }' || true)"
  local head
  head="$(printf '%s' "$status_response" | extract_indexer_head_height)"

  if [[ "$head" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$head"
    return 0
  fi

  printf '\n'
  return 1
}

wait_for_indexer_head_ready() {
  local warmup_seconds="$1"
  local poll_seconds="$2"
  local minimum_head="$3"
  local deadline=$((SECONDS + warmup_seconds))

  while (( SECONDS <= deadline )); do
    local current_head
    current_head="$(read_indexer_head || true)"

    if [[ "$current_head" =~ ^[0-9]+$ ]] && (( current_head >= minimum_head )); then
      printf '%s\n' "$current_head"
      return 0
    fi

    sleep "$poll_seconds"
  done

  printf '\n'
  return 1
}

extract_indexed_trades_count() {
  require_python3
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
root = data.get("data") if isinstance(data, dict) else None
trades = root.get("trades") if isinstance(root, dict) else None
if isinstance(trades, list):
    sys.stdout.write(str(len(trades)))'
}

load_env_file ".env"
load_env_file ".env.staging-e2e-real"

INDEXER_GRAPHQL_DEFAULT_URL="http://127.0.0.1:${INDEXER_GRAPHQL_PORT:-4350}/graphql"
INDEXER_GATEWAY_URL_HOST="${STAGING_E2E_REAL_GATE_INDEXER_GRAPHQL_URL:-$INDEXER_GRAPHQL_DEFAULT_URL}"
RPC_GATEWAY_URL_HOST="$(normalize_host_url "${STAGING_E2E_REAL_GATE_RPC_URL:-${RECONCILIATION_RPC_URL:-}}")"
NETWORK_NAME="${STAGING_E2E_REAL_NETWORK_NAME:-unknown}"
CHAIN_ID_VALUE="${STAGING_E2E_REAL_CHAIN_ID:-${RECONCILIATION_CHAIN_ID:-unknown}}"
REQUIRE_INDEXED_DATA="${STAGING_E2E_REAL_REQUIRE_INDEXED_DATA:-false}"
DYNAMIC_START_BLOCK="${STAGING_E2E_REAL_DYNAMIC_START_BLOCK:-true}"
START_BLOCK_BACKOFF="${STAGING_E2E_REAL_START_BLOCK_BACKOFF:-250}"
LAG_WARMUP_SECONDS="${STAGING_E2E_REAL_LAG_WARMUP_SECONDS:-180}"
LAG_POLL_SECONDS="${STAGING_E2E_REAL_LAG_POLL_SECONDS:-5}"
MAX_LAG="${STAGING_E2E_MAX_INDEXER_LAG_BLOCKS:-500}"
READINESS_RETRY_ATTEMPTS="${STAGING_E2E_READINESS_RETRY_ATTEMPTS:-30}"
READINESS_RETRY_DELAY="${STAGING_E2E_READINESS_RETRY_DELAY:-2}"

RUN_KEY="staging-e2e-real-gate-$(date +%s)"
RECONCILIATION_REPORT_PATH="reports/reconciliation/staging-e2e-real-report.json"

mkdir -p "$(dirname "$RECONCILIATION_REPORT_PATH")"

echo "Starting staging-e2e-real validation gate"
echo "profile=${PROFILE} indexerHostUrl=${INDEXER_GATEWAY_URL_HOST} rpcHostUrl=${RPC_GATEWAY_URL_HOST}"

require_integer_digits "STAGING_E2E_REAL_START_BLOCK_BACKOFF" "$START_BLOCK_BACKOFF"
require_integer_digits "STAGING_E2E_REAL_LAG_WARMUP_SECONDS" "$LAG_WARMUP_SECONDS"
require_integer_digits "STAGING_E2E_REAL_LAG_POLL_SECONDS" "$LAG_POLL_SECONDS"
require_integer_digits "STAGING_E2E_MAX_INDEXER_LAG_BLOCKS" "$MAX_LAG"
require_integer_digits "STAGING_E2E_READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_ATTEMPTS"
require_integer_digits "STAGING_E2E_READINESS_RETRY_DELAY" "$READINESS_RETRY_DELAY"

if [[ "$LAG_WARMUP_SECONDS" == "0" ]]; then
  fail "STAGING_E2E_REAL_LAG_WARMUP_SECONDS must be > 0"
fi

if [[ "$LAG_POLL_SECONDS" == "0" ]]; then
  fail "STAGING_E2E_REAL_LAG_POLL_SECONDS must be > 0"
fi

if [[ "$MAX_LAG" == "0" ]]; then
  fail "STAGING_E2E_MAX_INDEXER_LAG_BLOCKS must be > 0"
fi

if [[ "$READINESS_RETRY_ATTEMPTS" == "0" ]]; then
  fail "STAGING_E2E_READINESS_RETRY_ATTEMPTS must be > 0"
fi

if [[ "$READINESS_RETRY_DELAY" == "0" ]]; then
  fail "STAGING_E2E_READINESS_RETRY_DELAY must be > 0"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "staging-e2e-real gate failed with ${failures} check(s)" >&2
  exit 1
fi

if [[ "$DYNAMIC_START_BLOCK" == "true" && -n "$RPC_GATEWAY_URL_HOST" ]]; then
  RPC_START_HEAD_HEX="$(get_rpc_head_hex)"
  if [[ -n "$RPC_START_HEAD_HEX" && "$RPC_START_HEAD_HEX" =~ ^0x[0-9a-fA-F]+$ ]]; then
    RPC_START_HEAD_NUM="${RPC_START_HEAD_HEX#0x}"
    RPC_START_HEAD_NUM="$(printf '%s' "$RPC_START_HEAD_NUM" | tr '[:upper:]' '[:lower:]')"
    if [[ "$RPC_START_HEAD_NUM" =~ ^[0-9a-f]+$ ]]; then
      RPC_START_HEAD_DEC=$((16#${RPC_START_HEAD_NUM}))
      DYNAMIC_INDEXER_START_BLOCK=$((RPC_START_HEAD_DEC - START_BLOCK_BACKOFF))
      if (( DYNAMIC_INDEXER_START_BLOCK < 1 )); then
        DYNAMIC_INDEXER_START_BLOCK=1
      fi
      export INDEXER_START_BLOCK="$DYNAMIC_INDEXER_START_BLOCK"
      echo "dynamic start block: INDEXER_START_BLOCK=${INDEXER_START_BLOCK} (rpcHead=${RPC_START_HEAD_DEC}, backoff=${START_BLOCK_BACKOFF})"
    else
      echo "warning: invalid normalized RPC head value '${RPC_START_HEAD_NUM}' for dynamic start block; using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
    fi
  elif [[ -z "$RPC_START_HEAD_HEX" ]]; then
    echo "warning: unable to determine RPC head for dynamic start block; using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
  else
    echo "warning: invalid RPC head value '${RPC_START_HEAD_HEX}' for dynamic start block; using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
  fi
fi

if [[ "${STAGING_E2E_REAL_GATE_ASSERT_CONFIG_ONLY:-false}" == "true" ]]; then
  REPORT_VERSION="$(resolve_reconciliation_report_version)"
  REPORT_VERSION_JSON="$(printf '%s' "$REPORT_VERSION" | json_encode_string)"
  cat > "$RECONCILIATION_REPORT_PATH" <<EOF
{
  "reportVersion": ${REPORT_VERSION_JSON},
  "runKey": null,
  "mode": "config-only",
  "rows": [],
  "summary": {
    "rowCount": 0,
    "matchCount": 0,
    "mismatchCount": 0
  }
}
EOF
  echo "reconciliation report generated (config-only): path=${RECONCILIATION_REPORT_PATH}"
  INDEXER_START_BLOCK="${INDEXER_START_BLOCK:-}" scripts/docker-services.sh config "$PROFILE"
  exit 0
fi

INDEXER_START_BLOCK="${INDEXER_START_BLOCK:-}" scripts/docker-services.sh up "$PROFILE"
if scripts/docker-services.sh health "$PROFILE"; then
  pass "profile health check passed"
else
  fail "profile health check failed"
fi

if retry_cmd "indexer graphql readiness" "$READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_DELAY" run_graphql_query '{ __typename }' >/dev/null; then
  pass "indexer GraphQL readiness check passed"
else
  fail "indexer GraphQL readiness check failed"
fi

if retry_cmd "indexer graphql in-network readiness" "$READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_DELAY" run_graphql_query_from_reconciliation '{ __typename }' >/dev/null; then
  pass "indexer GraphQL in-network readiness check passed"
else
  fail "indexer GraphQL in-network readiness check failed"
fi

SCHEMA_RESPONSE="$(run_graphql_query 'query { trades(limit: 1) { tradeId buyer supplier status totalAmountLocked logisticsAmount platformFeesAmount supplierFirstTranche supplierSecondTranche ricardianHash createdAt arrivalTimestamp } }' || true)"
if printf '%s' "$SCHEMA_RESPONSE" | grep -q '"errors"'; then
  echo "schema parity query response: $SCHEMA_RESPONSE" >&2
  fail "schema parity check failed"
else
  pass "schema parity check passed"
fi

INDEXER_HEAD="$(wait_for_indexer_head_ready "$LAG_WARMUP_SECONDS" "$LAG_POLL_SECONDS" 0 || true)"
if [[ -n "$INDEXER_HEAD" ]]; then
  pass "indexer head metric available after warmup (height=${INDEXER_HEAD})"
else
  INDEXER_HEAD="$(get_indexer_head_from_db 2>/dev/null || true)"
  if [[ -n "$INDEXER_HEAD" ]]; then
    pass "indexer head fallback metric available from DB after warmup (height=${INDEXER_HEAD})"
  else
    fail "indexer head metric unavailable after ${LAG_WARMUP_SECONDS}s warmup"
  fi
fi

RPC_HEAD_HEX=""
if [[ -n "$RPC_GATEWAY_URL_HOST" ]]; then
  RPC_HEAD_HEX="$(get_rpc_head_hex)"
fi

if [[ -z "$RPC_HEAD_HEX" || -z "$INDEXER_HEAD" ]]; then
  fail "lag/head metrics unavailable"
elif [[ ! "$RPC_HEAD_HEX" =~ ^0x[0-9a-fA-F]+$ ]]; then
  fail "RPC head metric is not a valid hex value: ${RPC_HEAD_HEX}"
else
  # Strip the 0x prefix, then convert the remaining hexadecimal value to decimal.
  RPC_HEAD_NUM="${RPC_HEAD_HEX#0x}"
  RPC_HEAD_NUM="$(printf '%s' "$RPC_HEAD_NUM" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$RPC_HEAD_NUM" || ! "$RPC_HEAD_NUM" =~ ^[0-9a-f]+$ ]]; then
    fail "normalized RPC head value is not a valid hex number: ${RPC_HEAD_NUM}"
  else
    RPC_HEAD_DEC=$((16#${RPC_HEAD_NUM}))
    LAG=$((RPC_HEAD_DEC - INDEXER_HEAD))
    echo "lag/head metrics: rpcHead=${RPC_HEAD_DEC}, indexerHead=${INDEXER_HEAD}, lag=${LAG}"
    if [[ "$LAG" -lt 0 ]]; then
      fail "negative lag indicates possible chain mismatch"
    elif [[ "$LAG" -le "$MAX_LAG" ]]; then
      pass "indexer lag within threshold (${LAG} <= ${MAX_LAG})"
    else
      fail "indexer lag exceeds threshold (${LAG} > ${MAX_LAG})"
    fi
  fi
fi

TRADES_RESPONSE="$(run_graphql_query '{ trades(limit: 1) { tradeId } }' || true)"
INDEXED_TRADES_COUNT="$(printf '%s' "$TRADES_RESPONSE" | extract_indexed_trades_count)"
if [[ -z "$INDEXED_TRADES_COUNT" ]]; then
  INDEXED_TRADES_COUNT=0
fi

echo "indexed trade sample count=${INDEXED_TRADES_COUNT}"
if [[ "$REQUIRE_INDEXED_DATA" == "true" && "$INDEXED_TRADES_COUNT" -eq 0 ]]; then
  fail "indexed data requirement enabled but no indexed trades found"
elif [[ "$INDEXED_TRADES_COUNT" -eq 0 ]]; then
  echo "WARNING: no indexed trades found and deterministic on-chain seeding is not enabled for this profile."
  echo "         Set STAGING_E2E_REAL_REQUIRE_INDEXED_DATA=true only when the contracts are pre-seeded with test data."
  pass "indexed data check completed (require=${REQUIRE_INDEXED_DATA}, count=${INDEXED_TRADES_COUNT})"
else
  pass "indexed data check completed (require=${REQUIRE_INDEXED_DATA}, count=${INDEXED_TRADES_COUNT})"
fi

HEAD_BEFORE_RESTART="${INDEXER_HEAD:-}"
if run_compose ps --services --filter status=running | grep -qx 'indexer-pipeline'; then
  run_compose restart indexer-pipeline >/dev/null
  sleep 5
  if retry_cmd "indexer graphql readiness after pipeline restart" "$READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_DELAY" run_graphql_query '{ __typename }' >/dev/null; then
    STATUS_AFTER_RESTART="$(run_graphql_query '{ squidStatus { height } }' || true)"
    HEAD_AFTER_RESTART="$(printf '%s' "$STATUS_AFTER_RESTART" | extract_indexer_head_height)"
    if [[ -z "$HEAD_AFTER_RESTART" ]]; then
      HEAD_AFTER_RESTART="$(get_indexer_head_from_db 2>/dev/null || true)"
    fi

    if [[ -n "$HEAD_BEFORE_RESTART" && -n "$HEAD_AFTER_RESTART" ]]; then
      echo "reorg/resync probe: headBeforeRestart=${HEAD_BEFORE_RESTART}, headAfterRestart=${HEAD_AFTER_RESTART}"
      pass "reorg/resync probe completed"
    else
      fail "reorg/resync probe could not read head height after restart"
    fi
  else
    fail "reorg/resync probe failed after pipeline restart"
  fi
else
  fail "indexer-pipeline is not running for reorg/resync probe"
fi

if run_compose exec -T reconciliation node reconciliation/dist/cli.js once --run-key="$RUN_KEY" >/dev/null; then
  pass "reconciliation once run completed"
else
  fail "reconciliation once run failed"
fi

RUN_SUMMARY="$(run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${RECONCILIATION_DB_NAME}" -Atc "SELECT status || ',' || total_trades || ',' || drift_count FROM reconcile_runs WHERE run_key='${RUN_KEY}' ORDER BY id DESC LIMIT 1;" 2>/dev/null || true)"
if [[ -n "$RUN_SUMMARY" ]]; then
  IFS=',' read -r RUN_STATUS RUN_TOTAL RUN_DRIFT <<<"$RUN_SUMMARY"
  echo "reconciliation run summary: runKey=${RUN_KEY}, status=${RUN_STATUS}, totalTrades=${RUN_TOTAL}, driftCount=${RUN_DRIFT}"
  pass "reconciliation run summary captured"
else
  fail "reconciliation run summary unavailable"
fi

DRIFT_SUMMARY="$(run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${RECONCILIATION_DB_NAME}" -Atc "SELECT mismatch_code || ':' || COUNT(*) FROM reconcile_drifts WHERE run_key='${RUN_KEY}' GROUP BY mismatch_code ORDER BY COUNT(*) DESC;" 2>/dev/null || true)"
echo "drift classification snapshot:"
if [[ -n "$DRIFT_SUMMARY" ]]; then
  echo "$DRIFT_SUMMARY"
else
  echo "(no drift rows)"
fi

if run_compose exec -T reconciliation node reconciliation/dist/report-cli.js --run-key="$RUN_KEY" > "$RECONCILIATION_REPORT_PATH"; then
  echo "reconciliation report generated: path=${RECONCILIATION_REPORT_PATH}"
  pass "reconciliation report generated"
else
  rm -f "$RECONCILIATION_REPORT_PATH"
  fail "reconciliation report generation failed"
fi

CORRELATION_ROWS="$(run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" -Atc "SELECT COALESCE(trade_id,''), COALESCE(tx_hash,'') FROM trade_event ORDER BY block_number DESC LIMIT 5;" 2>/dev/null || true)"
echo "correlation snapshot (indexer + reconciliation context):"
if [[ -n "$CORRELATION_ROWS" ]]; then
  while IFS='|' read -r TRADE_ID TX_HASH; do
    printf '{"tradeId":%s,"actionKey":null,"requestId":null,"txHash":%s,"chainId":%s,"networkName":%s}\n' \
      "$(printf '%s' "${TRADE_ID}" | json_encode_string)" \
      "$(printf '%s' "${TX_HASH}" | json_encode_string)" \
      "$(printf '%s' "${CHAIN_ID_VALUE}" | json_encode_string)" \
      "$(printf '%s' "${NETWORK_NAME}" | json_encode_string)"
  done <<< "$CORRELATION_ROWS"
else
  printf '{"tradeId":null,"actionKey":null,"requestId":null,"txHash":null,"chainId":%s,"networkName":%s}\n' \
    "$(printf '%s' "${CHAIN_ID_VALUE}" | json_encode_string)" \
    "$(printf '%s' "${NETWORK_NAME}" | json_encode_string)"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "staging-e2e-real gate failed with ${failures} check(s)" >&2
  exit 1
fi

echo "staging-e2e-real gate passed"
