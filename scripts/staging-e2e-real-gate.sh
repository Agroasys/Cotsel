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

normalize_host_url() {
  local url="$1"
  echo "${url//host.docker.internal/127.0.0.1}"
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

retry_cmd() {
  local label="$1"
  local attempts="$2"
  local delay="$3"
  shift 3

  local i=1
  while (( i <= attempts )); do
    if "$@"; then
      return 0
    fi

    if (( i == attempts )); then
      echo "$label failed after ${attempts} attempt(s)" >&2
      return 1
    fi

    sleep "$delay"
    i=$((i + 1))
  done

  return 1
}

require_non_negative_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    fail "$name must be a non-negative integer (received: $value)"
    return 1
  fi

  return 0
}

run_graphql_query() {
  local query="$1"
  local payload
  payload=$(printf '{"query":%s}' "$(printf '%s' "$query" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")
  curl -fsS "${INDEXER_GATEWAY_URL_HOST}" \
    -H 'content-type: application/json' \
    --data "$payload"
}

run_graphql_query_from_reconciliation() {
  local query="$1"
  local payload
  payload=$(printf '{"query":%s}' "$(printf '%s' "$query" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")

  run_compose exec -T reconciliation node -e "
    const target = process.env.INDEXER_GRAPHQL_URL;
    if (!target) {
      process.exit(1);
    }
    fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: process.argv[1],
    }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
  " "$payload"
}

read_indexer_head() {
  local status_response
  status_response="$(run_graphql_query '{ squidStatus { height } }' || true)"
  local head
  head="$(printf '%s' "$status_response" | extract_json_value 'data.get("data",{}).get("squidStatus",{}).get("height")')"

  if [[ "$head" =~ ^-?[0-9]+$ ]]; then
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

    if [[ "$current_head" =~ ^-?[0-9]+$ ]] && (( current_head >= minimum_head )); then
      printf '%s\n' "$current_head"
      return 0
    fi

    sleep "$poll_seconds"
  done

  printf '\n'
  return 1
}

extract_json_value() {
  local expression="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); value=${expression}; print(value if value is not None else '')"
}

load_env_file ".env"
load_env_file ".env.staging-e2e-real"

INDEXER_GATEWAY_URL_HOST="${STAGING_E2E_REAL_GATE_INDEXER_GRAPHQL_URL:-http://127.0.0.1:${INDEXER_GRAPHQL_PORT:-4350}/graphql}"
RPC_GATEWAY_URL_HOST="$(normalize_host_url "${STAGING_E2E_REAL_GATE_RPC_URL:-${RECONCILIATION_RPC_URL:-}}")"
NETWORK_NAME="${STAGING_E2E_REAL_NETWORK_NAME:-unknown}"
CHAIN_ID_VALUE="${STAGING_E2E_REAL_CHAIN_ID:-${RECONCILIATION_CHAIN_ID:-unknown}}"
REQUIRE_INDEXED_DATA="${STAGING_E2E_REAL_REQUIRE_INDEXED_DATA:-false}"
DYNAMIC_START_BLOCK="${STAGING_E2E_REAL_DYNAMIC_START_BLOCK:-true}"
START_BLOCK_BACKOFF="${STAGING_E2E_REAL_START_BLOCK_BACKOFF:-250}"
LAG_WARMUP_SECONDS="${STAGING_E2E_REAL_LAG_WARMUP_SECONDS:-180}"
LAG_POLL_SECONDS="${STAGING_E2E_REAL_LAG_POLL_SECONDS:-5}"
MAX_LAG="${STAGING_E2E_MAX_INDEXER_LAG_BLOCKS:-500}"

RUN_KEY="phase3-gate-$(date +%s)"
RECONCILIATION_REPORT_PATH="reports/reconciliation/staging-e2e-real-report.json"

mkdir -p "$(dirname "$RECONCILIATION_REPORT_PATH")"

echo "Starting staging-e2e-real validation gate"
echo "profile=${PROFILE} indexerHostUrl=${INDEXER_GATEWAY_URL_HOST} rpcHostUrl=${RPC_GATEWAY_URL_HOST}"

require_non_negative_integer "STAGING_E2E_REAL_START_BLOCK_BACKOFF" "$START_BLOCK_BACKOFF" || true
require_non_negative_integer "STAGING_E2E_REAL_LAG_WARMUP_SECONDS" "$LAG_WARMUP_SECONDS" || true
require_non_negative_integer "STAGING_E2E_REAL_LAG_POLL_SECONDS" "$LAG_POLL_SECONDS" || true
require_non_negative_integer "STAGING_E2E_MAX_INDEXER_LAG_BLOCKS" "$MAX_LAG" || true

if [[ "$LAG_WARMUP_SECONDS" == "0" ]]; then
  fail "STAGING_E2E_REAL_LAG_WARMUP_SECONDS must be > 0"
fi

if [[ "$LAG_POLL_SECONDS" == "0" ]]; then
  fail "STAGING_E2E_REAL_LAG_POLL_SECONDS must be > 0"
fi

if [[ "$MAX_LAG" == "0" ]]; then
  fail "STAGING_E2E_MAX_INDEXER_LAG_BLOCKS must be > 0"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "staging-e2e-real gate failed with ${failures} check(s)" >&2
  exit 1
fi

if [[ "$DYNAMIC_START_BLOCK" == "true" && -n "$RPC_GATEWAY_URL_HOST" ]]; then
  RPC_START_HEAD_HEX="$(
    curl -fsS "${RPC_GATEWAY_URL_HOST}" \
      -H 'content-type: application/json' \
      --data '{"id":1,"jsonrpc":"2.0","method":"eth_blockNumber","params":[]}' \
      | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p' \
      | head -n1 || true
  )"
  if [[ -n "$RPC_START_HEAD_HEX" ]]; then
    RPC_START_HEAD_DEC=$((RPC_START_HEAD_HEX))
    DYNAMIC_INDEXER_START_BLOCK=$((RPC_START_HEAD_DEC - START_BLOCK_BACKOFF))
    if (( DYNAMIC_INDEXER_START_BLOCK < 1 )); then
      DYNAMIC_INDEXER_START_BLOCK=1
    fi
    export INDEXER_START_BLOCK="$DYNAMIC_INDEXER_START_BLOCK"
    echo "dynamic start block: INDEXER_START_BLOCK=${INDEXER_START_BLOCK} (rpcHead=${RPC_START_HEAD_DEC}, backoff=${START_BLOCK_BACKOFF})"
  else
    echo "warning: unable to determine RPC head for dynamic start block; using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
  fi
fi

if [[ "${STAGING_E2E_REAL_GATE_ASSERT_CONFIG_ONLY:-false}" == "true" ]]; then
  cat > "$RECONCILIATION_REPORT_PATH" <<EOF
{
  "reportVersion": "1.0",
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

if retry_cmd "indexer graphql readiness" 30 2 run_graphql_query '{ __typename }' >/dev/null; then
  pass "indexer GraphQL readiness check passed"
else
  fail "indexer GraphQL readiness check failed"
fi

if retry_cmd "indexer graphql in-network readiness" 30 2 run_graphql_query_from_reconciliation '{ __typename }' >/dev/null; then
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
  INDEXER_HEAD="$(run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" -Atc "SELECT COALESCE(MAX(block_number), 0) FROM trade_event;" 2>/dev/null || true)"
  if [[ -n "$INDEXER_HEAD" ]]; then
    pass "indexer head fallback metric available from DB after warmup (height=${INDEXER_HEAD})"
  else
    fail "indexer head metric unavailable after ${LAG_WARMUP_SECONDS}s warmup"
  fi
fi

RPC_HEAD_HEX=""
if [[ -n "$RPC_GATEWAY_URL_HOST" ]]; then
  RPC_HEAD_HEX="$(curl -fsS "${RPC_GATEWAY_URL_HOST}" -H 'content-type: application/json' --data '{"id":1,"jsonrpc":"2.0","method":"eth_blockNumber","params":[]}' | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -n1 || true)"
fi

if [[ -z "$RPC_HEAD_HEX" || -z "$INDEXER_HEAD" ]]; then
  fail "lag/head metrics unavailable"
elif [[ ! "$INDEXER_HEAD" =~ ^[0-9]+$ ]]; then
  fail "indexer head metric is not numeric: ${INDEXER_HEAD}"
else
  RPC_HEAD_DEC=$((RPC_HEAD_HEX))
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

TRADES_RESPONSE="$(run_graphql_query '{ trades(limit: 1) { tradeId } }' || true)"
INDEXED_TRADES_COUNT="$(printf '%s' "$TRADES_RESPONSE" | extract_json_value 'len(data.get("data",{}).get("trades",[]))')"
if [[ -z "$INDEXED_TRADES_COUNT" ]]; then
  INDEXED_TRADES_COUNT=0
fi

echo "indexed trade sample count=${INDEXED_TRADES_COUNT}"
if [[ "$REQUIRE_INDEXED_DATA" == "true" && "$INDEXED_TRADES_COUNT" -eq 0 ]]; then
  fail "indexed data requirement enabled but no indexed trades found"
elif [[ "$INDEXED_TRADES_COUNT" -eq 0 ]]; then
  echo "seed scenario note: repository has no deterministic on-chain seeder for Substrate/Revive in this profile; set STAGING_E2E_REAL_REQUIRE_INDEXED_DATA=true only when contract scope is pre-seeded."
  pass "indexed data check completed (require=${REQUIRE_INDEXED_DATA}, count=${INDEXED_TRADES_COUNT})"
else
  pass "indexed data check completed (require=${REQUIRE_INDEXED_DATA}, count=${INDEXED_TRADES_COUNT})"
fi

HEAD_BEFORE_RESTART="${INDEXER_HEAD:-}"
if run_compose ps --services --filter status=running | grep -qx 'indexer-pipeline'; then
  run_compose restart indexer-pipeline >/dev/null
  sleep 5
  if retry_cmd "indexer graphql readiness after pipeline restart" 30 2 run_graphql_query '{ __typename }' >/dev/null; then
    STATUS_AFTER_RESTART="$(run_graphql_query '{ squidStatus { height } }' || true)"
    HEAD_AFTER_RESTART="$(printf '%s' "$STATUS_AFTER_RESTART" | extract_json_value 'data.get("data",{}).get("squidStatus",{}).get("height")')"
    if [[ -z "$HEAD_AFTER_RESTART" ]]; then
      HEAD_AFTER_RESTART="$(run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" -Atc "SELECT COALESCE(MAX(block_number), 0) FROM trade_event;" 2>/dev/null || true)"
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
    printf '{"tradeId":"%s","actionKey":null,"requestId":null,"txHash":"%s","chainId":"%s","networkName":"%s"}\n' "${TRADE_ID}" "${TX_HASH}" "${CHAIN_ID_VALUE}" "${NETWORK_NAME}"
  done <<< "$CORRELATION_ROWS"
else
  printf '{"tradeId":null,"actionKey":null,"requestId":null,"txHash":null,"chainId":"%s","networkName":"%s"}\n' "${CHAIN_ID_VALUE}" "${NETWORK_NAME}"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "staging-e2e-real gate failed with ${failures} check(s)" >&2
  exit 1
fi

echo "staging-e2e-real gate passed"
