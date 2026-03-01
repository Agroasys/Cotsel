#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.services.yml"
PROFILE="staging-e2e-real"
failure_count=0
INDEXER_PIPELINE_SERVICE="${INDEXER_PIPELINE_SERVICE:-indexer-pipeline}"
PIPELINE_RESTART_SLEEP="${STAGING_E2E_REAL_PIPELINE_RESTART_SLEEP:-5}"
DEFAULT_MIN_INDEXER_START_BLOCK=1
# Default number of blocks to step back from current RPC head when deriving
# dynamic INDEXER_START_BLOCK. This keeps startup away from the volatile tip.
DEFAULT_START_BLOCK_BACKOFF=250
# Maximum allowed indexer lag (in blocks) before this gate considers the indexer unhealthy.
# Default 500 is conservative for mixed environments; tune per network block time/SLO.
DEFAULT_MAX_INDEXER_LAG_BLOCKS=500
# Use ASCII Unit Separator (0x1F) as delimiter to minimize collisions with normal text data
# in reconciliation run and drift summary queries below.
RECONCILIATION_SUMMARY_FIELD_DELIM=$'\x1f'

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  else
    echo "Warning: environment file not found, skipping: $file" >&2
  fi
}

# Normalize URLs that use Docker's internal hostname so they work from the host,
# by converting host.docker.internal to 127.0.0.1 for host-side access.
normalize_host_url() {
  local url="$1"
  echo "${url//host.docker.internal/127.0.0.1}"
}

run_with_prefixed_stderr() {
  local prefix="$1"
  shift
  "$@" 2> >(sed "s/^/[${prefix}] /" >&2)
}

is_service_running() {
  local service="$1"
  run_compose ps --services --filter status=running \
    | tr '[:space:]' '\n' \
    | grep -Fxq "$service"
}

get_rpc_head_hex() {
  local rpc_head_hex=""
  if [[ -n "${RPC_GATEWAY_URL_HOST:-}" ]]; then
    local curl_output=""
    local curl_status=0
    curl_output="$(
      curl -fsS "${RPC_GATEWAY_URL_HOST}" \
        -H 'content-type: application/json' \
        --data '{"id":1,"jsonrpc":"2.0","method":"eth_blockNumber","params":[]}' \
        2>&1
    )" || curl_status=$?

    if [[ "$curl_status" -ne 0 ]]; then
      echo "[get_rpc_head_hex] failed to query RPC at '${RPC_GATEWAY_URL_HOST}' (curl exit code: ${curl_status})" >&2
      if [[ -n "$curl_output" ]]; then
        printf '%s\n' "$curl_output" >&2
      fi
      rpc_head_hex=""
    else
      rpc_head_hex="$(
        printf '%s\n' "$curl_output" \
          | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p' \
          | head -n1
      )"
      if [[ -z "$rpc_head_hex" ]]; then
        echo "[get_rpc_head_hex] RPC response from '${RPC_GATEWAY_URL_HOST}' did not contain a valid hex block number result." \
          "Expected JSON-RPC 'eth_blockNumber' with a 'result' field containing a hex string like '0x1234'." \
          "This can be caused by malformed/non-JSON output, a missing/different 'result' field, a non-hex result value," \
          "or an unexpected response structure (for example an HTML error page)." \
          "Check the RPC response below and verify endpoint URL/auth and 'eth_blockNumber' support." >&2
        if [[ -n "$curl_output" ]]; then
          printf '%s\n' "$curl_output" >&2
        fi
      fi
    fi
  fi
  printf '%s\n' "$rpc_head_hex"
}

hex_to_decimal() {
  local hex_value="$1"
  require_python3
  python3 - "$hex_value" <<'PY'
import sys

value = sys.argv[1].strip().lower()
if value.startswith("0x"):
    value = value[2:]

if not value or any(ch not in "0123456789abcdef" for ch in value):
    sys.exit(1)

print(int(value, 16))
PY
}

get_indexer_head_from_db() {
  validate_identifier "POSTGRES_USER" "${POSTGRES_USER:-}" || return 1
  validate_identifier "INDEXER_DB_NAME" "${INDEXER_DB_NAME:-}" || return 1
  run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" -Atc 'SELECT COALESCE(MAX(block_number), 0) FROM trade_event;'
}

run_compose() {
  docker compose -f "$COMPOSE_FILE" --profile "$PROFILE" "$@"
}

pass() {
  echo "[PASS] $1"
}

fail() {
  echo "[FAIL] $1" >&2
  failure_count=$((failure_count + 1))
}

validate_identifier() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    fail "$name must not be empty."
    return 1
  fi
  if [[ ! "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    fail "$name contains invalid characters. Allowed characters are: letters, digits, underscore (_), and hyphen (-)."
    return 1
  fi
  return 0
}

validate_run_key() {
  if [[ -z "${RUN_KEY:-}" ]]; then
    fail "RUN_KEY is not set or empty"
    exit 1
  fi
  if [[ ! "$RUN_KEY" =~ ^[A-Za-z0-9._-]+$ ]]; then
    fail "RUN_KEY contains invalid characters"
    exit 1
  fi
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

  # Validation errors are accumulated via the global failure counter.
  # Always return success so the gate can report all validation failures at once.
  return 0
}

require_positive_value() {
  local name="$1"
  local value="$2"
  # Reuse digit validation so non-numeric values are flagged consistently.
  require_integer_digits "$name" "$value"
  if (( 10#$value == 0 )); then
    fail "$name must be > 0"
  fi
  return 0
}

is_valid_hex() {
  local value="${1:-}"
  [[ "$value" =~ ^0x[0-9a-fA-F]+$ ]]
}

json_encode_string() {
  require_python3
  python3 -c 'import json, sys, traceback
data = sys.stdin.read().rstrip("\n")
data_len = len(data)
try:
    print(json.dumps(data))
except Exception as e:
    sys.stderr.write(
        "Error: failed to JSON-encode stdin for GraphQL payload: {err}\n"
        "  Python version: {pyver}\n"
        "  stdin encoding: {enc}\n"
        "  input length (characters): {length}\n"
        "This is unexpected for text input and may indicate invalid/binary data\n"
        "or an environment/encoding misconfiguration.\n".format(
            err=e,
            pyver=sys.version.replace("\n", " "),
            enc=getattr(sys.stdin, "encoding", None),
            length=data_len,
        )
    )
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)'
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

  run_compose exec -T -e COMPOSE_FILE_NAME="${COMPOSE_FILE}" reconciliation node - "$payload" <<'NODE'
const target = process.env.INDEXER_GRAPHQL_URL;
if (!target) {
  const composeFileName = process.env.COMPOSE_FILE_NAME || 'compose.yaml';
  console.error(
    '[reconciliation] INDEXER_GRAPHQL_URL is not set. ' +
      `Configure INDEXER_GRAPHQL_URL for the reconciliation service (for example in ${composeFileName} or a .env file) ` +
      'as the full HTTP(S) URL of the indexer GraphQL endpoint, such as https://your-indexer-host/graphql.'
  );
  process.exit(1);
}
fetch(target, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: process.argv[2],
})
  .then(async (response) => {
    let result;
    try {
      result = await response.json();
    } catch (e) {
      console.error('Failed to parse GraphQL response as JSON:', e);
      process.exit(1);
    }

    if (!response.ok) {
      console.error(
        `GraphQL HTTP request failed: status=${response.status} ${response.statusText || ''}`.trim()
      );
      console.error('Response body:', JSON.stringify(result));
      process.exit(1);
    }

    const hasErrors = Array.isArray(result && result.errors) && result.errors.length > 0;
    const hasData = !!(result && Object.prototype.hasOwnProperty.call(result, 'data'));
    if (hasErrors || !hasData) {
      console.error('GraphQL request returned errors or missing data.');
      if (hasErrors) {
        console.error('Errors:', JSON.stringify(result.errors, null, 2));
      }
      if (!hasData) {
        console.error('Response did not contain a "data" field.');
      }
      process.exit(1);
    }

    process.exit(0);
  })
  .catch((err) => {
    console.error('Error while executing GraphQL request:', err);
    process.exit(1);
  });
NODE
}

extract_indexer_head_height() {
  require_python3
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception as e:
    print(
        f"Warning: JSON parsing failed, treating indexer head height as unavailable and continuing. "
        f"Check whether INDEXER_GRAPHQL_URL is returning valid JSON (for example by inspecting the raw HTTP response or the reconciliation/indexer-pipeline service logs in the current COMPOSE_FILE stack). "
        f"Details: {e}",
        file=sys.stderr,
    )
    sys.exit(0)
root = data.get("data") if isinstance(data, dict) else None
squid_status = root.get("squidStatus") if isinstance(root, dict) else None
height = squid_status.get("height") if isinstance(squid_status, dict) else None
if isinstance(height, int):
    sys.stdout.write(str(height))
else:
    # Explicitly return an empty value when height is absent/non-integer.
    sys.stdout.write("")'
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

calculate_dynamic_start_block() {
  local rpc_start_head_hex=""
  local rpc_start_head_dec=""
  local dynamic_indexer_start_block=0
  local backoff_value="${START_BLOCK_BACKOFF:-$DEFAULT_START_BLOCK_BACKOFF}"
  local min_start_block="$DEFAULT_MIN_INDEXER_START_BLOCK"
  local configured_min_start_block="${MIN_INDEXER_START_BLOCK:-}"

  if [[ -n "${START_BLOCK_BACKOFF:-}" && ! "${START_BLOCK_BACKOFF}" =~ ^[0-9]+$ ]]; then
    echo "warning: invalid START_BLOCK_BACKOFF='${START_BLOCK_BACKOFF}' for dynamic start block; defaulting to ${DEFAULT_START_BLOCK_BACKOFF}" >&2
    backoff_value="$DEFAULT_START_BLOCK_BACKOFF"
  fi
  if [[ -n "$configured_min_start_block" ]]; then
    if [[ "$configured_min_start_block" =~ ^[0-9]+$ ]]; then
      min_start_block="$configured_min_start_block"
    else
      echo "warning: invalid MIN_INDEXER_START_BLOCK='${configured_min_start_block}' for dynamic start block; defaulting to ${DEFAULT_MIN_INDEXER_START_BLOCK}" >&2
      min_start_block="$DEFAULT_MIN_INDEXER_START_BLOCK"
    fi
  fi

  rpc_start_head_hex="$(get_rpc_head_hex)"
  if [[ -n "$rpc_start_head_hex" ]] && is_valid_hex "$rpc_start_head_hex"; then
    rpc_start_head_dec="$(hex_to_decimal "$rpc_start_head_hex" 2>/dev/null || true)"
    if [[ -n "$rpc_start_head_dec" && "$rpc_start_head_dec" =~ ^[0-9]+$ ]]; then
      dynamic_indexer_start_block=$((rpc_start_head_dec - backoff_value))
      if (( dynamic_indexer_start_block < min_start_block )); then
        dynamic_indexer_start_block=min_start_block
      fi
      export INDEXER_START_BLOCK="$dynamic_indexer_start_block"
      echo "dynamic start block: INDEXER_START_BLOCK=${INDEXER_START_BLOCK} (rpcHead=${rpc_start_head_dec}, backoff=${backoff_value}, minStartBlock=${min_start_block})"
    else
      echo "warning: invalid normalized RPC head value '${rpc_start_head_dec}' for dynamic start block (from hex '${rpc_start_head_hex}'); using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
    fi
  elif [[ -z "$rpc_start_head_hex" ]]; then
    echo "warning: unable to determine RPC head for dynamic start block; using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
  else
    echo "warning: invalid RPC head value '${rpc_start_head_hex}' for dynamic start block; using existing INDEXER_START_BLOCK=${INDEXER_START_BLOCK:-unset}" >&2
  fi
}

extract_indexed_trades_count() {
  require_python3
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.stderr.write("Failed to parse JSON for trades count\n")
    sys.stdout.write("0")
    sys.exit(0)
root = data.get("data") if isinstance(data, dict) else None
trades = root.get("trades") if isinstance(root, dict) else None
if isinstance(trades, list):
    sys.stdout.write(str(len(trades)))
else:
    sys.stdout.write("0")'
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
START_BLOCK_BACKOFF="${STAGING_E2E_REAL_START_BLOCK_BACKOFF:-$DEFAULT_START_BLOCK_BACKOFF}"
LAG_WARMUP_SECONDS="${STAGING_E2E_REAL_LAG_WARMUP_SECONDS:-180}"
LAG_POLL_SECONDS="${STAGING_E2E_REAL_LAG_POLL_SECONDS:-5}"
MAX_INDEXER_LAG_BLOCKS="${STAGING_E2E_MAX_INDEXER_LAG_BLOCKS:-$DEFAULT_MAX_INDEXER_LAG_BLOCKS}"
READINESS_RETRY_ATTEMPTS="${STAGING_E2E_REAL_READINESS_RETRY_ATTEMPTS:-30}"
READINESS_RETRY_DELAY="${STAGING_E2E_REAL_READINESS_RETRY_DELAY:-2}"
MIN_INDEXER_START_BLOCK="${STAGING_E2E_REAL_MIN_INDEXER_START_BLOCK:-$DEFAULT_MIN_INDEXER_START_BLOCK}"

RUN_KEY="staging-e2e-real-gate-$(date +%s)"
validate_run_key
RECONCILIATION_REPORT_PATH="reports/reconciliation/staging-e2e-real-report.json"

mkdir -p "$(dirname "$RECONCILIATION_REPORT_PATH")"

echo "Starting staging-e2e-real validation gate"
echo "profile=${PROFILE} indexerHostUrl=${INDEXER_GATEWAY_URL_HOST} rpcHostUrl=${RPC_GATEWAY_URL_HOST}"

require_integer_digits "STAGING_E2E_REAL_START_BLOCK_BACKOFF" "$START_BLOCK_BACKOFF"
require_integer_digits "STAGING_E2E_REAL_LAG_WARMUP_SECONDS" "$LAG_WARMUP_SECONDS"
require_integer_digits "STAGING_E2E_REAL_LAG_POLL_SECONDS" "$LAG_POLL_SECONDS"
require_integer_digits "STAGING_E2E_MAX_INDEXER_LAG_BLOCKS" "$MAX_INDEXER_LAG_BLOCKS"
require_integer_digits "STAGING_E2E_REAL_READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_ATTEMPTS"
require_integer_digits "STAGING_E2E_REAL_READINESS_RETRY_DELAY" "$READINESS_RETRY_DELAY"
require_integer_digits "STAGING_E2E_REAL_PIPELINE_RESTART_SLEEP" "$PIPELINE_RESTART_SLEEP"
require_integer_digits "STAGING_E2E_REAL_MIN_INDEXER_START_BLOCK" "$MIN_INDEXER_START_BLOCK"

require_positive_value "STAGING_E2E_REAL_LAG_WARMUP_SECONDS" "$LAG_WARMUP_SECONDS"
require_positive_value "STAGING_E2E_REAL_LAG_POLL_SECONDS" "$LAG_POLL_SECONDS"
require_positive_value "STAGING_E2E_MAX_INDEXER_LAG_BLOCKS" "$MAX_INDEXER_LAG_BLOCKS"
require_positive_value "STAGING_E2E_REAL_READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_ATTEMPTS"
require_positive_value "STAGING_E2E_REAL_READINESS_RETRY_DELAY" "$READINESS_RETRY_DELAY"
require_positive_value "STAGING_E2E_REAL_PIPELINE_RESTART_SLEEP" "$PIPELINE_RESTART_SLEEP"

if [[ "$failure_count" -gt 0 ]]; then
  echo "staging-e2e-real gate failed with ${failure_count} check(s)" >&2
  exit 1
fi

if [[ "$DYNAMIC_START_BLOCK" == "true" && -n "$RPC_GATEWAY_URL_HOST" ]]; then
  calculate_dynamic_start_block
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

# Validate identifiers before the first non-config-only DB access path.
validate_identifier "POSTGRES_USER" "${POSTGRES_USER:-}"
validate_identifier "RECONCILIATION_DB_NAME" "${RECONCILIATION_DB_NAME:-}"
validate_identifier "INDEXER_DB_NAME" "${INDEXER_DB_NAME:-}"

INDEXER_START_BLOCK="${INDEXER_START_BLOCK:-}" scripts/docker-services.sh up "$PROFILE"
if scripts/docker-services.sh health "$PROFILE"; then
  pass "profile health check passed"
else
  fail "profile health check failed"
fi

if retry_cmd "indexer graphql readiness" "$READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_DELAY" run_graphql_query 'query { trades(limit: 1) { tradeId } }' >/dev/null; then
  pass "indexer GraphQL readiness check passed"
else
  fail "indexer GraphQL readiness check failed"
fi

if retry_cmd "indexer graphql in-network readiness" "$READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_DELAY" run_graphql_query_from_reconciliation 'query { trades(limit: 1) { tradeId } }' >/dev/null; then
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
  INDEXER_HEAD="$(
    run_with_prefixed_stderr "get_indexer_head_from_db" get_indexer_head_from_db || true
  )"
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
elif ! is_valid_hex "$RPC_HEAD_HEX"; then
  fail "RPC head metric is not a valid hex value: ${RPC_HEAD_HEX}"
else
  # Strip the 0x prefix, then convert the remaining hexadecimal value to decimal.
  RPC_HEAD_DEC="$(hex_to_decimal "$RPC_HEAD_HEX" 2>/dev/null || true)"
  if [[ -z "$RPC_HEAD_DEC" || ! "$RPC_HEAD_DEC" =~ ^[0-9]+$ ]]; then
    fail "normalized RPC head value is not a valid hex number: ${RPC_HEAD_HEX}"
  elif [[ -z "$INDEXER_HEAD" || ! "$INDEXER_HEAD" =~ ^[0-9]+$ ]]; then
    fail "indexer head value is not a valid decimal number: ${INDEXER_HEAD}"
  else
    INDEXER_HEAD_DEC="${INDEXER_HEAD}"
    LAG=$((RPC_HEAD_DEC - INDEXER_HEAD_DEC))
    echo "lag/head metrics: rpcHead=${RPC_HEAD_DEC}, indexerHead=${INDEXER_HEAD_DEC}, lag=${LAG}"
    if [[ "$LAG" -lt 0 ]]; then
      # Re-read RPC head once to avoid false negatives from read timing races.
      if [[ -n "$RPC_GATEWAY_URL_HOST" ]]; then
        NEW_RPC_HEAD_HEX="$(get_rpc_head_hex)"
        if is_valid_hex "$NEW_RPC_HEAD_HEX"; then
          NEW_RPC_HEAD_DEC="$(hex_to_decimal "$NEW_RPC_HEAD_HEX" 2>/dev/null || true)"
          if [[ -n "$NEW_RPC_HEAD_DEC" && "$NEW_RPC_HEAD_DEC" =~ ^[0-9]+$ ]]; then
            RPC_HEAD_DEC="$NEW_RPC_HEAD_DEC"
            LAG=$((RPC_HEAD_DEC - INDEXER_HEAD_DEC))
            echo "rechecked lag/head metrics: rpcHead=${RPC_HEAD_DEC}, indexerHead=${INDEXER_HEAD_DEC}, lag=${LAG}"
          fi
        fi
      fi
      if [[ "$LAG" -lt 0 ]]; then
        fail "negative lag (${LAG} blocks): rpcHead=${RPC_HEAD_DEC} < indexerHead=${INDEXER_HEAD_DEC} indicates possible chain mismatch; verify RPC_GATEWAY_URL_HOST and indexer settings point to the same network/chain"
      elif [[ "$LAG" -le "$MAX_INDEXER_LAG_BLOCKS" ]]; then
        pass "indexer lag within threshold (${LAG} <= ${MAX_INDEXER_LAG_BLOCKS})"
      else
        fail "indexer lag exceeds threshold (${LAG} > ${MAX_INDEXER_LAG_BLOCKS})"
      fi
    elif [[ "$LAG" -le "$MAX_INDEXER_LAG_BLOCKS" ]]; then
      pass "indexer lag within threshold (${LAG} <= ${MAX_INDEXER_LAG_BLOCKS})"
    else
      fail "indexer lag exceeds threshold (${LAG} > ${MAX_INDEXER_LAG_BLOCKS})"
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
  echo "WARNING: no indexed trades found and REQUIRE_INDEXED_DATA is not enabled."
  echo "         This is expected when STAGING_E2E_REAL_REQUIRE_INDEXED_DATA=false; zero indexed trades do not fail this check in that mode."
  echo "         Enable STAGING_E2E_REAL_REQUIRE_INDEXED_DATA=true only when deterministic on-chain seeding or pre-seeded test data is configured for this profile."
  pass "indexed data check completed without requiring indexed data (require=${REQUIRE_INDEXED_DATA}, count=${INDEXED_TRADES_COUNT})"
else
  pass "indexed data check completed (require=${REQUIRE_INDEXED_DATA}, count=${INDEXED_TRADES_COUNT})"
fi

HEAD_BEFORE_RESTART="${INDEXER_HEAD:-}"
if is_service_running "${INDEXER_PIPELINE_SERVICE}"; then
  run_compose restart "${INDEXER_PIPELINE_SERVICE}" >/dev/null
  sleep "$PIPELINE_RESTART_SLEEP"
  if retry_cmd "indexer graphql readiness after pipeline restart" "$READINESS_RETRY_ATTEMPTS" "$READINESS_RETRY_DELAY" run_graphql_query 'query { trades(limit: 1) { tradeId } }' >/dev/null; then
    STATUS_AFTER_RESTART="$(run_graphql_query '{ squidStatus { height } }' || true)"
    HEAD_AFTER_RESTART="$(printf '%s' "$STATUS_AFTER_RESTART" | extract_indexer_head_height)"
    if [[ -z "$HEAD_AFTER_RESTART" ]]; then
      HEAD_AFTER_RESTART="$(
        run_with_prefixed_stderr "get_indexer_head_from_db" get_indexer_head_from_db || true
      )"
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
  fail "${INDEXER_PIPELINE_SERVICE} is not running for reorg/resync probe"
fi

if run_compose exec -T reconciliation node reconciliation/dist/cli.js once --run-key="$RUN_KEY" >/dev/null; then
  pass "reconciliation once run completed"
else
  fail "reconciliation once run failed"
fi

RUN_SUMMARY_SQL="$(cat <<'SQL'
SELECT status, total_trades, drift_count
FROM reconcile_runs
WHERE run_key = :'run_key_var'
ORDER BY id DESC
LIMIT 1;
SQL
)"
RUN_SUMMARY="$(run_with_prefixed_stderr "reconcile_run_summary" run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${RECONCILIATION_DB_NAME}" -v run_key_var="${RUN_KEY}" -A -F "${RECONCILIATION_SUMMARY_FIELD_DELIM}" -tc "${RUN_SUMMARY_SQL}" || true)"
if [[ -n "$RUN_SUMMARY" ]]; then
  IFS="${RECONCILIATION_SUMMARY_FIELD_DELIM}" read -r RUN_STATUS RUN_TOTAL RUN_DRIFT <<<"$RUN_SUMMARY"
  echo "reconciliation run summary: runKey=${RUN_KEY}, status=${RUN_STATUS}, totalTrades=${RUN_TOTAL}, driftCount=${RUN_DRIFT}"
  pass "reconciliation run summary captured"
else
  fail "reconciliation run summary unavailable"
fi

DRIFT_SUMMARY_SQL="$(cat <<'SQL'
SELECT mismatch_code, COUNT(*)
FROM reconcile_drifts
WHERE run_key = :'run_key_var'
GROUP BY mismatch_code
ORDER BY COUNT(*) DESC;
SQL
)"
DRIFT_SUMMARY_ROWS="$(run_with_prefixed_stderr "reconcile_drift_summary" run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${RECONCILIATION_DB_NAME}" -v run_key_var="${RUN_KEY}" -A -F "${RECONCILIATION_SUMMARY_FIELD_DELIM}" -tc "${DRIFT_SUMMARY_SQL}" || true)"
echo "drift classification snapshot:"
if [[ -n "$DRIFT_SUMMARY_ROWS" ]]; then
  while IFS="${RECONCILIATION_SUMMARY_FIELD_DELIM}" read -r MISMATCH_CODE MISMATCH_COUNT; do
    echo "${MISMATCH_CODE}:${MISMATCH_COUNT}"
  done <<< "$DRIFT_SUMMARY_ROWS"
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

CORRELATION_SQL="$(cat <<'SQL'
SELECT
  replace(replace(COALESCE(trade_id, ''), chr(31), ' '), E'\t', ' '),
  replace(replace(COALESCE(tx_hash, ''), chr(31), ' '), E'\t', ' ')
FROM trade_event
ORDER BY block_number DESC
LIMIT 5;
SQL
)"
CORRELATION_ROWS="$(run_with_prefixed_stderr "indexer_correlation_query" run_compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${INDEXER_DB_NAME}" -A -F "${RECONCILIATION_SUMMARY_FIELD_DELIM}" -tc "${CORRELATION_SQL}" || true)"
echo "correlation snapshot (indexer + reconciliation context):"
if [[ -n "$CORRELATION_ROWS" ]]; then
  while IFS="${RECONCILIATION_SUMMARY_FIELD_DELIM}" read -r TRADE_ID TX_HASH; do
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

if [[ "$failure_count" -gt 0 ]]; then
  echo "staging-e2e-real gate failed with ${failure_count} check(s)" >&2
  exit 1
fi

echo "staging-e2e-real gate passed"
