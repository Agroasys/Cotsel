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

if [[ ! -f ".env" ]]; then
  echo "Missing required base env file: .env" >&2
  exit 1
fi

if [[ "$PROFILE" != "infra" && ! -f "$PROFILE_FILE" ]]; then
  echo "Missing required profile env file: $PROFILE_FILE" >&2
  exit 1
fi

load_env_file ".env"
if [[ -f "$PROFILE_FILE" ]]; then
  load_env_file "$PROFILE_FILE"
fi

required_groups=(
  # shared compose/database inputs
  POSTGRES_USER
  POSTGRES_PASSWORD
  RICARDIAN_DB_NAME
  TREASURY_DB_NAME
  ORACLE_DB_NAME
  RECONCILIATION_DB_NAME
  INDEXER_DB_NAME
)

if [[ "$PROFILE" == "local-dev" || "$PROFILE" == "staging-e2e" || "$PROFILE" == "staging-e2e-real" ]]; then
  required_groups+=(
    # service ports used by local/staging compose profiles
    RICARDIAN_PORT
    TREASURY_PORT
    ORACLE_PORT

    # oracle config aliases:
    # left side = profile key used in compose; right side = direct runtime key used in oracle/src/config.ts
    ORACLE_API_KEY\|API_KEY
    ORACLE_HMAC_SECRET\|HMAC_SECRET
    ORACLE_PRIVATE_KEY
    ORACLE_RPC_URL\|RPC_URL
    ORACLE_CHAIN_ID\|CHAIN_ID
    ORACLE_ESCROW_ADDRESS\|ESCROW_ADDRESS
    ORACLE_USDC_ADDRESS\|USDC_ADDRESS
    ORACLE_INDEXER_GRAPHQL_URL\|INDEXER_GRAPHQL_URL
    ORACLE_RETRY_ATTEMPTS\|RETRY_ATTEMPTS
    ORACLE_RETRY_DELAY\|RETRY_DELAY

    # reconciliation config aliases (reconciliation/src/config.ts)
    RECONCILIATION_RPC_URL\|RPC_URL
    RECONCILIATION_CHAIN_ID\|CHAIN_ID
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

if [[ "$PROFILE" == "staging-e2e" || "$PROFILE" == "staging-e2e-real" ]]; then
  required_groups+=(
    # indexer pipeline aliases (indexer/src/config.ts)
    INDEXER_GATEWAY_URL\|GATEWAY_URL
    INDEXER_RPC_ENDPOINT\|RPC_ENDPOINT
    INDEXER_START_BLOCK\|START_BLOCK
    INDEXER_RATE_LIMIT\|RATE_LIMIT
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
fi

echo "env validation passed for profile: $PROFILE"
