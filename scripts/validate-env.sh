#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"

usage() {
  echo "Usage: scripts/validate-env.sh <local-dev|staging-e2e|staging-e2e-real|infra>" >&2
}

if [[ -z "$PROFILE" ]]; then
  usage
  exit 1
fi

case "$PROFILE" in
  local-dev)
    PROFILE_FILE=".env.local"
    ;;
  staging-e2e)
    PROFILE_FILE=".env.staging-e2e"
    ;;
  staging-e2e-real)
    PROFILE_FILE=".env.staging-e2e-real"
    ;;
  infra)
    PROFILE_FILE=".env.infra"
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

ORIGINAL_ENV_KEYS=()
ORIGINAL_ENV_VALUES=()
while IFS='=' read -r key value; do
  ORIGINAL_ENV_KEYS+=("$key")
  ORIGINAL_ENV_VALUES+=("$value")
done < <(env)

restore_external_environment_overrides() {
  local idx=0
  for key in "${ORIGINAL_ENV_KEYS[@]}"; do
    export "$key=${ORIGINAL_ENV_VALUES[$idx]}"
    idx=$((idx + 1))
  done
}

if [[ ! -f ".env" ]]; then
  echo "Missing required base env file: .env" >&2
  echo "Create it from the checked-in template: cp .env.example .env" >&2
  exit 1
fi

if [[ "$PROFILE" != "infra" && ! -f "$PROFILE_FILE" ]]; then
  echo "Missing required profile env file: $PROFILE_FILE" >&2
  echo "Create it from the checked-in template: cp ${PROFILE_FILE}.example ${PROFILE_FILE}" >&2
  exit 1
fi

load_env_file ".env"
restore_external_environment_overrides
if [[ -f "$PROFILE_FILE" ]]; then
  load_env_file "$PROFILE_FILE"
fi
restore_external_environment_overrides

required_groups=(
  # shared compose/database inputs
  POSTGRES_USER
  POSTGRES_PASSWORD
  AUTH_DB_NAME
  GATEWAY_DB_NAME
  RICARDIAN_DB_NAME
  TREASURY_DB_NAME
  ORACLE_DB_NAME
  RECONCILIATION_DB_NAME
  INDEXER_DB_NAME
)

if [[ "$PROFILE" == "local-dev" || "$PROFILE" == "staging-e2e" || "$PROFILE" == "staging-e2e-real" ]]; then
  required_groups+=(
    # service ports used by local/staging compose profiles
    AUTH_PORT
    AUTH_SESSION_TTL_SECONDS
    RICARDIAN_PORT
    TREASURY_PORT
    ORACLE_PORT

    # oracle config aliases:
    # left side = profile key used in compose; right side = direct runtime key used in oracle/src/config.ts
    ORACLE_API_KEY\|API_KEY
    ORACLE_HMAC_SECRET\|HMAC_SECRET
    ORACLE_PRIVATE_KEY
    ORACLE_SETTLEMENT_RUNTIME\|SETTLEMENT_RUNTIME\|ORACLE_RPC_URL\|RPC_URL
    ORACLE_SETTLEMENT_RUNTIME\|SETTLEMENT_RUNTIME\|ORACLE_CHAIN_ID\|CHAIN_ID
    ORACLE_ESCROW_ADDRESS\|ESCROW_ADDRESS
    ORACLE_USDC_ADDRESS\|USDC_ADDRESS
    ORACLE_INDEXER_GRAPHQL_URL\|INDEXER_GRAPHQL_URL
    ORACLE_RETRY_ATTEMPTS\|RETRY_ATTEMPTS
    ORACLE_RETRY_DELAY\|RETRY_DELAY

    # reconciliation config aliases (reconciliation/src/config.ts)
    RECONCILIATION_SETTLEMENT_RUNTIME\|SETTLEMENT_RUNTIME\|RECONCILIATION_RPC_URL\|RPC_URL
    RECONCILIATION_SETTLEMENT_RUNTIME\|SETTLEMENT_RUNTIME\|RECONCILIATION_CHAIN_ID\|CHAIN_ID
    RECONCILIATION_ESCROW_ADDRESS\|ESCROW_ADDRESS
    RECONCILIATION_USDC_ADDRESS\|USDC_ADDRESS
    RECONCILIATION_INDEXER_GRAPHQL_URL\|INDEXER_GRAPHQL_URL

    # treasury config aliases (treasury/src/config.ts)
    TREASURY_INDEXER_GRAPHQL_URL\|INDEXER_GRAPHQL_URL

    # notifications aliases (oracle/reconciliation config.ts)
    ORACLE_NOTIFICATIONS_ENABLED
    ORACLE_NOTIFICATIONS_COOLDOWN_MS
    ORACLE_NOTIFICATIONS_REQUEST_TIMEOUT_MS
    RECONCILIATION_NOTIFICATIONS_ENABLED
    RECONCILIATION_NOTIFICATIONS_COOLDOWN_MS
    RECONCILIATION_NOTIFICATIONS_REQUEST_TIMEOUT_MS
  )
fi

if [[ "$PROFILE" == "staging-e2e-real" ]]; then
  required_groups+=(
    GATEWAY_AUTH_BASE_URL
    GATEWAY_INDEXER_GRAPHQL_URL
    GATEWAY_SETTLEMENT_RUNTIME\|GATEWAY_RPC_URL
    GATEWAY_SETTLEMENT_RUNTIME\|GATEWAY_CHAIN_ID
    GATEWAY_ESCROW_ADDRESS
  )
fi

if [[ "$PROFILE" == "staging-e2e" || "$PROFILE" == "staging-e2e-real" ]]; then
  required_groups+=(
    # indexer pipeline aliases (indexer/src/config.ts)
    INDEXER_RPC_ENDPOINT\|RPC_ENDPOINT
    INDEXER_START_BLOCK\|START_BLOCK
    INDEXER_RATE_LIMIT\|RATE_LIMIT
    FINALITY_CONFIRMATION_BLOCKS
    INDEXER_GRAPHQL_PORT\|GRAPHQL_PORT
    INDEXER_CONTRACT_ADDRESS\|CONTRACT_ADDRESS
  )
fi

if [[ "$PROFILE" == "staging-e2e-real" ]]; then
  required_groups+=(
    # real staging gate context
    STAGING_E2E_REAL_NETWORK_NAME
    STAGING_E2E_REAL_CHAIN_ID
  )
fi

missing_groups=()
for group in "${required_groups[@]}"; do
  IFS='|' read -r -a keys <<< "$group"
  found=0
  for key in "${keys[@]}"; do
    if [[ -n "${!key:-}" ]]; then
      found=1
      break
    fi
  done

  if [[ "$found" -eq 0 ]]; then
    missing_groups+=("$group")
  fi
done

if [[ "${#missing_groups[@]}" -gt 0 ]]; then
  echo "Missing required env keys for profile '$PROFILE':" >&2
  for group in "${missing_groups[@]}"; do
    echo "  - ${group//|/ or }" >&2
  done
  echo "Review .env and ${PROFILE_FILE}; external environment variables may override file values." >&2
  exit 1
fi

if [[ "$PROFILE" == "local-dev" || "$PROFILE" == "staging-e2e" || "$PROFILE" == "staging-e2e-real" ]]; then
  if [[ "${ORACLE_NOTIFICATIONS_ENABLED:-}" != "true" && "${ORACLE_NOTIFICATIONS_ENABLED:-}" != "false" ]]; then
    echo "ORACLE_NOTIFICATIONS_ENABLED must be true or false" >&2
    exit 1
  fi

  if [[ "${RECONCILIATION_NOTIFICATIONS_ENABLED:-}" != "true" && "${RECONCILIATION_NOTIFICATIONS_ENABLED:-}" != "false" ]]; then
    echo "RECONCILIATION_NOTIFICATIONS_ENABLED must be true or false" >&2
    exit 1
  fi

  if [[ "${ORACLE_NOTIFICATIONS_ENABLED:-false}" == "true" && -z "${ORACLE_NOTIFICATIONS_WEBHOOK_URL:-}" ]]; then
    echo "ORACLE_NOTIFICATIONS_WEBHOOK_URL is required when ORACLE_NOTIFICATIONS_ENABLED=true" >&2
    exit 1
  fi

  if [[ "${RECONCILIATION_NOTIFICATIONS_ENABLED:-false}" == "true" && -z "${RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL:-}" ]]; then
    echo "RECONCILIATION_NOTIFICATIONS_WEBHOOK_URL is required when RECONCILIATION_NOTIFICATIONS_ENABLED=true" >&2
    exit 1
  fi

  rate_limit_service_prefixes=(AUTH RICARDIAN TREASURY ORACLE GATEWAY)
  for service_prefix in "${rate_limit_service_prefixes[@]}"; do
    enabled_key="${service_prefix}_RATE_LIMIT_ENABLED"
    redis_key="${service_prefix}_RATE_LIMIT_REDIS_URL"
    enabled_value="${!enabled_key:-}"

    if [[ "$enabled_value" != "true" && "$enabled_value" != "false" ]]; then
      echo "${enabled_key} must be true or false" >&2
      exit 1
    fi

    if [[ "$enabled_value" == "true" && -z "${!redis_key:-}" ]]; then
      echo "${redis_key} is required when ${enabled_key}=true" >&2
      exit 1
    fi
  done
fi

optional_numeric_keys=(
  INDEXER_RPC_CAPACITY
  INDEXER_RPC_MAX_BATCH_CALL_SIZE
  INDEXER_RPC_REQUEST_TIMEOUT_MS
  INDEXER_RPC_RETRY_ATTEMPTS
  INDEXER_RPC_HEAD_POLL_INTERVAL_MS
  INDEXER_RPC_BLOCK_SPLIT_SIZE
)

for key in "${optional_numeric_keys[@]}"; do
  value="${!key:-}"
  if [[ -n "$value" && ! "$value" =~ ^[0-9]+$ ]]; then
    echo "$key must be a whole number when set" >&2
    exit 1
  fi
done

if [[ -n "${INDEXER_RPC_INGEST_DISABLED:-}" && "${INDEXER_RPC_INGEST_DISABLED}" != "true" && "${INDEXER_RPC_INGEST_DISABLED}" != "false" ]]; then
  echo "INDEXER_RPC_INGEST_DISABLED must be true or false when set" >&2
  exit 1
fi

contains_retired_runtime_marker() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == *legacy* || "$value" == *retired* || "$value" == *archive* || "$value" == *deprecated* ]]
}

if [[ "$PROFILE" == "staging-e2e-real" ]]; then
  if [[ "${STAGING_E2E_REAL_NETWORK_NAME:-}" != "Base Sepolia" ]]; then
    echo "STAGING_E2E_REAL_NETWORK_NAME must be 'Base Sepolia' for M4 pilot readiness" >&2
    exit 1
  fi

  if [[ "${STAGING_E2E_REAL_CHAIN_ID:-}" != "84532" ]]; then
    echo "STAGING_E2E_REAL_CHAIN_ID must be 84532 for Base Sepolia pilot readiness" >&2
    exit 1
  fi

  for var_name in INDEXER_GATEWAY_URL INDEXER_RPC_ENDPOINT ORACLE_RPC_URL RECONCILIATION_RPC_URL GATEWAY_RPC_URL; do
    value="${!var_name:-}"
    if contains_retired_runtime_marker "$value"; then
      echo "$var_name still points at historical chain infrastructure: $value" >&2
      exit 1
    fi
  done

  if [[ -n "${ORACLE_SETTLEMENT_RUNTIME:-}" && "${ORACLE_SETTLEMENT_RUNTIME:-}" != "base-sepolia" ]]; then
    echo "ORACLE_SETTLEMENT_RUNTIME must be base-sepolia for staging-e2e-real" >&2
    exit 1
  fi

  if [[ -n "${RECONCILIATION_SETTLEMENT_RUNTIME:-}" && "${RECONCILIATION_SETTLEMENT_RUNTIME:-}" != "base-sepolia" ]]; then
    echo "RECONCILIATION_SETTLEMENT_RUNTIME must be base-sepolia for staging-e2e-real" >&2
    exit 1
  fi

  if [[ -n "${GATEWAY_SETTLEMENT_RUNTIME:-}" && "${GATEWAY_SETTLEMENT_RUNTIME:-}" != "base-sepolia" ]]; then
    echo "GATEWAY_SETTLEMENT_RUNTIME must be base-sepolia for staging-e2e-real" >&2
    exit 1
  fi

  for var_name in ORACLE_CHAIN_ID RECONCILIATION_CHAIN_ID GATEWAY_CHAIN_ID; do
    value="${!var_name:-}"
    if [[ -n "$value" && "$value" != "84532" ]]; then
      echo "$var_name must be 84532 for staging-e2e-real" >&2
      exit 1
    fi
  done
fi

echo "env validation passed for profile: $PROFILE"
