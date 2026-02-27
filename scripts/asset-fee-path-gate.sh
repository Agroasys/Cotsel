#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"

usage() {
  echo "Usage: scripts/asset-fee-path-gate.sh <local-dev|staging-e2e-real>" >&2
}

if [[ -z "$PROFILE" ]]; then
  usage
  exit 1
fi

case "$PROFILE" in
  local-dev)
    PROFILE_FILE=".env.local"
    EXPECTED_BEHAVIOR_DEFAULT="native-fallback"
    ;;
  staging-e2e-real)
    PROFILE_FILE=".env.staging-e2e-real"
    EXPECTED_BEHAVIOR_DEFAULT="usdc-preferred"
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

if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "Missing required profile env file: $PROFILE_FILE" >&2
  exit 1
fi

load_env_file ".env"
load_env_file "$PROFILE_FILE"

MODE="live"
if [[ "${ASSET_FEE_PATH_ASSERT_CONFIG_ONLY:-true}" == "true" ]]; then
  MODE="config-only"
fi

REPORT_DIR="${ASSET_FEE_PATH_REPORT_DIR:-reports/asset-fee-path}"
REPORT_FILE="${REPORT_DIR}/${PROFILE}.json"

if [[ "$PROFILE" == "local-dev" ]]; then
  RPC_URL="${LOCAL_DEV_FEE_PATH_RPC_URL:-${ORACLE_RPC_URL:-${RECONCILIATION_RPC_URL:-}}}"
  EXPECTED_CHAIN_ID="${LOCAL_DEV_FEE_PATH_EXPECTED_CHAIN_ID:-${ORACLE_CHAIN_ID:-${RECONCILIATION_CHAIN_ID:-}}}"
  EXPECTED_BEHAVIOR="${LOCAL_DEV_FEE_PATH_EXPECTED_BEHAVIOR:-$EXPECTED_BEHAVIOR_DEFAULT}"
  CREATE_TX_HASH="${LOCAL_DEV_FEE_PATH_CREATE_TX_HASH:-}"
  SETTLEMENT_TX_HASHES="${LOCAL_DEV_FEE_PATH_SETTLEMENT_TX_HASHES:-}"
  ALLOW_NATIVE_FALLBACK="${LOCAL_DEV_FEE_PATH_ALLOW_NATIVE_FALLBACK:-true}"
else
  RPC_URL="${STAGING_E2E_REAL_FEE_PATH_RPC_URL:-${ORACLE_RPC_URL:-${RECONCILIATION_RPC_URL:-}}}"
  EXPECTED_CHAIN_ID="${STAGING_E2E_REAL_FEE_PATH_EXPECTED_CHAIN_ID:-${ORACLE_CHAIN_ID:-${RECONCILIATION_CHAIN_ID:-}}}"
  EXPECTED_BEHAVIOR="${STAGING_E2E_REAL_FEE_PATH_EXPECTED_BEHAVIOR:-$EXPECTED_BEHAVIOR_DEFAULT}"
  CREATE_TX_HASH="${STAGING_E2E_REAL_FEE_PATH_CREATE_TX_HASH:-}"
  SETTLEMENT_TX_HASHES="${STAGING_E2E_REAL_FEE_PATH_SETTLEMENT_TX_HASHES:-}"
  ALLOW_NATIVE_FALLBACK="${STAGING_E2E_REAL_FEE_PATH_ALLOW_NATIVE_FALLBACK:-true}"
fi

mkdir -p "$REPORT_DIR"

if [[ -n "$RPC_URL" ]]; then
  export FEE_PATH_RPC_URL="$RPC_URL"
fi

if [[ -n "$EXPECTED_CHAIN_ID" ]]; then
  export FEE_PATH_EXPECTED_CHAIN_ID="$EXPECTED_CHAIN_ID"
fi

export FEE_PATH_PROFILE="$PROFILE"
export FEE_PATH_MODE="$MODE"
export FEE_PATH_EXPECTED_BEHAVIOR="$EXPECTED_BEHAVIOR"
export FEE_PATH_CREATE_TX_HASH="$CREATE_TX_HASH"
export FEE_PATH_SETTLEMENT_TX_HASHES="$SETTLEMENT_TX_HASHES"
export FEE_PATH_ALLOW_NATIVE_FALLBACK="$ALLOW_NATIVE_FALLBACK"
export FEE_PATH_OUT_FILE="$REPORT_FILE"

echo "Running asset fee-path gate: profile=${PROFILE} mode=${MODE} report=${REPORT_FILE}"
node scripts/asset-fee-path-validate.mjs
