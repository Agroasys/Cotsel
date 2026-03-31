#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_DASHBOARD_REPO_DIR="$ROOT_DIR/../Cotsel-Dash"
if [[ -d "$ROOT_DIR/../tmp/pr-reviews/Cotsel-Dash" ]]; then
  DEFAULT_DASHBOARD_REPO_DIR="$ROOT_DIR/../tmp/pr-reviews/Cotsel-Dash"
fi

BACKEND_REPO_DIR="${AGROASYS_BACKEND_REPO_DIR:-$ROOT_DIR/../agroasys-backend}"
DASHBOARD_REPO_DIR="${DASHBOARD_LIVE_SUITE_REPO_DIR:-$DEFAULT_DASHBOARD_REPO_DIR}"

run_step() {
  local label="$1"
  shift

  echo "[m3-continuity] ${label}"
  "$@"
}

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

run_backend_continuity_contracts() {
  (
    cd "$BACKEND_REPO_DIR"
    pnpm test -- \
      src/modules/settlement-handoff/services/cotsel-settlement.client.spec.ts \
      src/modules/settlement-handoff/services/settlement-handoff.service.spec.ts
  )
}

run_gateway_continuity_contracts() {
  (
    cd "$ROOT_DIR"
    npm run -w gateway test -- \
      tradeReadService.test.ts \
      tradeRoutes.contract.test.ts \
      settlementRoutes.contract.test.ts
  )
}

run_dashboard_connected_contracts() {
  (
    cd "$DASHBOARD_REPO_DIR"
    npm test -- \
      src/test/api-contracts.test.ts \
      src/test/connected-read-adapters.test.ts \
      src/test/connected-governance-adapters.test.ts
  )
}

run_live_parity() {
  (
    cd "$ROOT_DIR"
    load_env_file ".env.example"
    load_env_file ".env.local.example"
    load_env_file ".env"
    load_env_file ".env.local"
    LOCAL_DEV_INDEXER_FIXTURE_MODE="dashboard-parity" \
      DASHBOARD_LIVE_SUITE_REPO_DIR="$DASHBOARD_REPO_DIR" \
      npm run dashboard:parity:ci
  )
}

main() {
  if [[ ! -d "$BACKEND_REPO_DIR" || ! -f "$BACKEND_REPO_DIR/package.json" ]]; then
    echo "Agroasys backend repository not found at ${BACKEND_REPO_DIR}" >&2
    exit 1
  fi

  if [[ ! -d "$DASHBOARD_REPO_DIR" || ! -f "$DASHBOARD_REPO_DIR/package.json" ]]; then
    echo "Cotsel-Dash repository not found at ${DASHBOARD_REPO_DIR}" >&2
    exit 1
  fi

  run_step "backend settlement-handoff continuity" run_backend_continuity_contracts
  run_step "gateway Base-era contract continuity" run_gateway_continuity_contracts
  run_step "dashboard connected contract continuity" run_dashboard_connected_contracts
  run_step "live local parity across gateway and dashboard" run_live_parity
}

main "$@"
